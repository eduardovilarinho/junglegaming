# Arquitetura

Este documento registra as decisões, os trade-offs e as limitações do serviço.
Como rodar e testar está no [README](README.md).

## Visão geral

```
 Provider ──HTTP──► WageringController ─┐
                                        ├─► ProcessWagerTransaction ──► uma transação SQL no PostgreSQL:
 Provider ──SQS───► ConsumidorDeTransacoes┘   (mesmo caso de uso)          1. inbox (só fila)
            wager-transactions.fifo                                       2. reserva da Idempotency-Key
                         │ falha permanente / N entregas                  3. SELECT ... FOR UPDATE na carteira
                         ▼                                                4. regras de domínio (settle)
            wager-transactions-dlq.fifo                                   5. transação, saldo, lançamento,
                                                                             reversão e eventos (outbox)
                                                                                     │ commit
 PendenciasWorker ── retenta PENDING_REFERENCE (FOR UPDATE SKIP LOCKED) ◄─────────────┤
 OutboxWorker ────── publica outbox_events (FOR UPDATE SKIP LOCKED) ──► wallet-events.fifo
```

Tudo que altera dinheiro acontece numa única transação SQL. Eventos só saem depois do commit,
pelo publicador do outbox. Todas as instâncias rodam os mesmos workers; o banco divide o trabalho.

## Camadas (DDD)

| Camada | Conteúdo | Depende de |
|---|---|---|
| `domain` | Agregados `Wallet` e `WagerTransaction`, `LedgerEntry` imutável, `Money`, regras (`WagerSettlement`), eventos, códigos de falha | nada |
| `application` | Casos de uso e portas (`UnitOfWork`, repositórios, `EventPublisher`, `Telemetry`, `Clock`) | domain |
| `infrastructure` | SQL sobre MikroORM, SQS, Zitadel, health, logs JSON, métricas, configuração | application, domain |
| `interfaces` | HTTP (NestJS), consumidor SQS, workers | application |
| `modulos` | Composição com NestJS (`useFactory`) | todos |

Domínio e aplicação não importam NestJS, MikroORM nem AWS SDK. Os casos de uso são classes comuns,
instanciadas pelos módulos; isso permite testar o núcleo inteiro contra o PostgreSQL sem subir o Nest.

## Modelo de domínio

**Money.** `bigint` em unidades menores (centavos), escala fixa de 2 casas, sempre com `Currency`.
Na API, dinheiro é um objeto `{ "amount": "10.50", "currency": "BRL" }` (formato do enunciado); nos
eventos, string decimal. O valor é sempre string: números JSON são recusados (400), porque ponto flutuante
não representa centavos com exatidão. No banco, `bigint`. O modelo é multimoeda: operações entre moedas
diferentes lançam erro, e cada carteira tem uma moeda.

**Wallet.** Construtor privado, `Wallet.open()`, `Wallet.openWithInitialBalance()` e `Wallet.rehydrate()`.
Uma por jogador e moeda. Saldo nunca negativo. `version` começa em 1 na criação (com ou sem saldo inicial)
e só aumenta quando o saldo muda; cada mudança produz exatamente um `LedgerEntry` com
`walletVersion` = versão da carteira depois dele. O crédito de abertura é o lançamento da versão 1.

**LedgerEntry.** Imutável, sem métodos de alteração. Correções são novos lançamentos (ROLLBACK).
Guarda `balanceBefore` e `balanceAfter`; a factory confere `balanceBefore ± valor = balanceAfter`, e o
banco confere o mesmo com uma `CHECK`. Os testes conferem a corrente inteira: o saldo anterior de cada
lançamento é o saldo posterior do anterior.

**WagerTransaction.** Construtor privado, `receive()`, `opening()` e `rehydrate()` (sem revalidar).
Guarda o saldo observado ao concluir (`balanceAfter`), devolvido também nas repetições. Máquina de estados explícita:

```
PENDING ──► PROCESSED | REJECTED | FAILED            (terminais)
   └────► PENDING_REFERENCE ──► PROCESSED | REJECTED | FAILED
               ▲      │
               └──────┘ nova tentativa com backoff
```

Transições a partir de estados terminais lançam `InvalidStateTransitionError`.

**WagerSettlement.** Serviço de domínio puro com as regras de cada operação. Recebe os agregados
já carregados e travados, altera só eles e devolve o lançamento, a reversão e os eventos.

| Operação | Efeito | Referência |
|---|---|---|
| BET | débito; recusa sem saldo (`INSUFFICIENT_FUNDS`) | não aceita |
| WIN | crédito | opcional; se houver, BET processado da mesma rodada |
| LOSS | registra o resultado, sem lançamento | opcional, como WIN |
| REFUND | crédito igual ao BET, uma única vez | obrigatória; só BET |
| ROLLBACK | efeito inverso: de BET credita; de WIN ou REFUND debita | obrigatória; BET, WIN ou REFUND |

A referência é resolvida por `providerId` + `externalTransactionId` e precisa coincidir em jogador,
carteira, moeda e rodada. Reversões exigem o mesmo valor (sem estorno parcial). Uma reversão que
deixaria o saldo negativo é rejeitada com `REVERSAL_WOULD_MAKE_BALANCE_NEGATIVE`, código diferente de
`INSUFFICIENT_FUNDS`: não é uma aposta recusada, é uma reversão impossível.

**OPENING.** Saldo inicial positivo cria uma transação interna `OPENING` (provider `internal`) e o
crédito no ledger, no mesmo commit da carteira. Assim o ledger explica 100% do saldo.

## Concorrência

**Unidade de concorrência: a carteira.** Cada operação faz `SELECT ... FOR UPDATE` na linha da carteira
antes de aplicar as regras. Operações na mesma carteira são serializadas; carteiras diferentes não se
bloqueiam (sem lock global).

**Por que lock pessimista.** As regras precisam ler mais do que o saldo: a transação referenciada,
se ela já foi revertida, o id externo. Com lock otimista, cada leitura vira um ponto de conflito e o
número de novas tentativas cresce com a disputa. Com o lock na carteira, a sequência ler-calcular-gravar
fica correta por construção e o raciocínio é local. O custo é a espera em carteiras muito disputadas,
limitada por `LOCK_TIMEOUT_MS` (lock_timeout por transação): estourou, o pedido devolve 503 com
`Retry-After` (HTTP) ou volta à fila com backoff (SQS).

**Defesa em profundidade.** Mesmo com o lock:
- o `UPDATE` do saldo é condicional à versão lida (`WHERE version = ?`); se zero linhas mudarem, a
  operação falha em vez de sobrescrever;
- o banco recusa saldo negativo (`CHECK`), lançamento duplicado por carteira e transação, versão
  repetida, reversão duplicada e id externo duplicado (`UNIQUE` / `PRIMARY KEY`);
- deadlock e falha de serialização (`40P01`, `40001`) e corridas esperadas em `UNIQUE` são repetidas
  automaticamente, com limite de tentativas.

**Ordem dos locks.** HTTP e fila: chave de idempotência, depois carteira. Worker de pendências:
linha da pendência (`SKIP LOCKED`), depois carteira. Leituras de referência não travam linhas,
então não há ciclo de espera entre os caminhos.

## Idempotência

- **HTTP:** `Idempotency-Key` é obrigatória e é a fonte da verdade.
- **Fila:** usa `data.idempotencyKey` da mensagem, ou o padrão `providerId:externalTransactionId`.
- **Hash do pedido:** SHA-256 do JSON canônico dos campos de negócio (chaves ordenadas, valor normalizado).
  `"10.5"` e `"10.50"` geram o mesmo hash.
- **Mesma chave e mesmo hash:** devolve a resposta original (mesmo status, mesmo `transactionId` e o saldo
  observado naquele momento), com `idempotentReplay: true` e o cabeçalho `Idempotent-Replayed: true`.
  Mesma chave e outro hash: 409.
- **Escopo da chave:** global, como o enunciado define (a chave é a fonte da verdade). O padrão recomendado,
  `providerId:externalTransactionId`, já separa os providers. Dois providers que usem a mesma chave crua
  recebem 409 no segundo, nunca o resultado do outro (o `providerId` faz parte do hash).
- **Mesmo id externo com outra chave:** devolve o original se o hash bater, senão 409.
  Garantido por `UNIQUE (provider_id, external_transaction_id)`.
- **Corrida com a mesma chave:** a reserva é um `INSERT ... ON CONFLICT DO NOTHING` na tabela
  `idempotency_keys`. Requisições concorrentes com a mesma chave esperam no índice único até a primeira
  terminar, e então leem o resultado dela. É o que faz 50 BETs idênticos em paralelo gerarem um débito.
- **Persistente:** nada de idempotência fica em memória; tudo está no PostgreSQL, na mesma transação do efeito.

## Mensageria

- **Filas FIFO:** `wager-transactions.fifo` (entrada), `wager-transactions-dlq.fifo` (DLQ) e
  `wallet-events.fifo` (eventos). O enunciado não define o destino dos eventos; a escolha foi uma fila FIFO
  com `MessageGroupId` = carteira, para manter a ordem por carteira.
- **Não dependemos da FIFO para correção:** a ordem e a deduplicação do SQS ajudam, mas a correção vem
  do banco (lock, inbox, idempotência, constraints). Mensagens fora de ordem são tratadas pela regra de
  referência pendente.
- **Formato da mensagem:** `{ messageId, type: "WagerTransactionRequested", occurredAt, data }`, com a
  transação em `data` no mesmo formato do corpo HTTP (mais `idempotencyKey` opcional). Mensagem fora desse
  formato é erro permanente (DLQ).
- **Inbox:** `(consumer, messageId)` gravado na mesma transação SQL do efeito. O `messageId` é o do envelope,
  definido pelo produtor, e não o `MessageId` do SQS: se o produtor reenviar a mesma mensagem, o SQS gera
  outro id, mas a inbox reconhece a repetição. Um reenvio com outro `messageId` cai na idempotência.
- **Ack só depois do commit:** `DeleteMessage` acontece depois do commit. Se o processo cair entre os dois,
  a mensagem volta após o `VisibilityTimeout` e a inbox impede o efeito duplicado. O teste
  `multi-instancia` reproduz isso com `FAULT_CRASH_AFTER_COMMIT`, um gancho usado só em teste.
- **Classificação de erros:**
  - **negócio:** a rejeição é gravada e a mensagem é confirmada;
  - **passageiro** (banco, lock, rede): `ChangeMessageVisibility` com backoff exponencial (2^entregas s, até 60 s);
  - **permanente** (JSON inválido, formato, conflito de idempotência): a mensagem vai para a DLQ com
    `failureReason`. Depois de `SQS_MAX_RECEIVE_COUNT` entregas, o redrive do SQS também leva à DLQ.
- **Desligamento:** no `SIGTERM`, o consumidor para de buscar, termina as mensagens em curso e devolve
  as não iniciadas (`VisibilityTimeout = 0`). Os workers terminam a rodada antes de o banco desconectar
  (`beforeApplicationShutdown`).

## Outbox

Eventos são gravados em `outbox_events` na mesma transação do efeito e publicados depois do commit
pelo `OutboxWorker`. Cada instância trava um lote (100) com `FOR UPDATE SKIP LOCKED`, então publicadores
concorrentes não pegam o mesmo evento. O envio usa `SendMessageBatch` (10 eventos por chamada) e marca
evento a evento o que a fila aceitou; os recusados voltam com nova tentativa. A entrega é **pelo menos uma vez**: se a fila aceitar e o commit
falhar, o evento sai de novo. O `eventId` vai como `MessageDeduplicationId` (deduplicação do SQS
por 5 minutos) e permite deduplicação no consumidor. Falha ao publicar agenda nova tentativa com
backoff, sem perder o evento. O atraso do outbox é exposto em `outbox_lag_seconds`.

Eventos (classe base abstrata `DomainEvent` e uma subclasse por tipo; dinheiro como string):
`WagerTransactionProcessed` (inclusive LOSS), `WagerTransactionRejected`, `WalletBalanceChanged`
(só quando o saldo muda) e `WagerTransactionPendingReference`.

## Referências pendentes

Referência ausente, ou presente mas ainda sem resultado final, leva a transação a `PENDING_REFERENCE`
com `next_retry_at`. O `PendenciasWorker` retenta com backoff exponencial
(`PENDING_BASE_DELAY_MS * 2^tentativa`, até `PENDING_MAX_DELAY_MS`). Depois de `PENDING_MAX_ATTEMPTS`
novas tentativas, a transação é rejeitada com `REFERENCE_NOT_FOUND` e o evento `WagerTransactionRejected`
é publicado. O evento `WagerTransactionPendingReference` sai só na primeira vez.

## Taxonomia de falhas

Códigos estáveis em `failureCode` (rejeições de negócio, HTTP 422):

| Código | Quando |
|---|---|
| `INSUFFICIENT_FUNDS` | BET maior que o saldo |
| `REVERSAL_WOULD_MAKE_BALANCE_NEGATIVE` | ROLLBACK de WIN ou REFUND sem saldo para desfazer |
| `WALLET_NOT_FOUND` | carteira inexistente |
| `WALLET_PLAYER_MISMATCH` | carteira de outro jogador |
| `CURRENCY_MISMATCH` | moeda da transação diferente da carteira |
| `REFERENCE_NOT_FOUND` | referência não chegou dentro do limite de tentativas |
| `REFERENCE_MISMATCH` | referência de outro jogador, carteira, moeda ou rodada |
| `REFERENCE_NOT_PROCESSED` | referência rejeitada ou falhou |
| `INVALID_REFERENCE_TYPE` | tipo não aceito (REFUND de não-BET, ROLLBACK de LOSS ou ROLLBACK) |
| `REVERSAL_AMOUNT_MISMATCH` | valor da reversão diferente do referenciado |
| `ALREADY_REVERSED` | a transação já foi revertida |
| `PERMANENT_PROCESSING_ERROR` | reservado para falhas permanentes (estado FAILED) |

Todo erro HTTP sai no formato `{ statusCode, error, message }`, com `error` estável, inclusive os do
framework (JSON malformado, rota inexistente); erro inesperado é 500 `INTERNAL_ERROR`, com o detalhe só no log.

| HTTP | `error` | Significado |
|---|---|---|
| 400 | `INVALID_PAYLOAD` | formato inválido, campo faltando, dinheiro como número, `Idempotency-Key` ausente |
| 401 | `UNAUTHENTICATED` | sem token ou token inválido |
| 403 | `FORBIDDEN` | provider do token diferente do da transação |
| 404 | `NOT_FOUND` | recurso inexistente |
| 409 | `IDEMPOTENCY_CONFLICT` | mesma chave ou id externo com conteúdo diferente |
| 409 | `WALLET_ALREADY_EXISTS` | jogador já tem carteira na moeda |
| 422 | (corpo da transação) | rejeição de negócio, com `failureCode` |
| 202 | (corpo da transação) | aceita, aguardando referência |
| 503 | `SERVICE_UNAVAILABLE` | falha passageira (banco, lock): tente de novo (`Retry-After`) |

## Banco de dados

Migrações versionadas e reversíveis (`up`/`down`) em `src/infrastructure/persistencia/mikro-orm/migracoes`,
rodadas pelo `migrator` do MikroORM dentro do Bun (`bun run db:migrate`). O SQL do núcleo financeiro
fica em `sql/schema.ts`, compartilhado entre a migração e os testes.

| Tabela | Garantias no schema |
|---|---|
| `wallets` | `UNIQUE (player_id, currency)`, `CHECK (balance >= 0)`, `CHECK (version >= 1)`, formato da moeda |
| `wager_transactions` | `UNIQUE (provider_id, external_transaction_id)`, tipos e estados válidos, `failure_code` presente se e só se REJECTED/FAILED, `next_retry_at` presente se e só se PENDING_REFERENCE |
| `transaction_reversals` | `PRIMARY KEY (reversed_transaction_id)`: cada transação revertida no máximo uma vez |
| `ledger_entries` | `UNIQUE (wallet_id, transaction_id)`, `UNIQUE (wallet_id, wallet_version)`, valor positivo, saldos antes e depois não negativos, `CHECK (balance_after = balance_before ± amount)`, **trigger que bloqueia UPDATE, DELETE e TRUNCATE** |
| `idempotency_keys` | `PRIMARY KEY (key)` |
| `inbox_messages` | `PRIMARY KEY (consumer, message_id)` |
| `outbox_events` | índice parcial dos não publicados |
| `reconciliation_reports` | histórico de reconciliações, com `consistent` |

**SQL explícito no núcleo.** O MikroORM gerencia conexão, transações e migrações. Os repositórios do
núcleo financeiro usam SQL explícito (`em.execute`) em vez de entidades do ORM, porque o que garante a
correção precisa ficar visível e revisável: `FOR UPDATE`, `SKIP LOCKED`, `ON CONFLICT` e `UPDATE`
condicional à versão. O catálogo de Games, sem requisitos de concorrência, usa entidades do MikroORM.
O snapshot das migrações só conhece as entidades; por isso o schema financeiro é sempre alterado por
migração escrita à mão, nunca por `schema:update`.

## Observabilidade

- **Logs:** JSON estruturado, uma linha por evento, com `correlationId` (cabeçalho `X-Correlation-Id`
  ou gerado), `messageId`, `transactionId`, `walletId` e `providerId`, propagados por `AsyncLocalStorage`.
  Os logs não incluem payloads financeiros completos nem dados pessoais.
- **Métricas (`GET /metrics`, Prometheus):**
  - `wager_transactions_total{type,status}`
  - `wager_duplicate_requests_total{origin}` e `wager_duplicate_messages_total`
  - `wager_retries_total{reason}` e `wager_lock_conflicts_total`
  - `wager_dlq_messages_total`
  - `outbox_lag_seconds`
  - `wager_processing_latency_ms` (histograma)
  - `wallet_reconciliation_divergences_total`
- **Health:** `/health/live` (processo de pé) e `/health/ready` (PostgreSQL e fila de transações alcançáveis,
  com tempo limite de 2 s cada), ambos sem autenticação.

## Autenticação e multi-tenancy

O provider é o tenant. Com `AUTH_MODE=zitadel`, o token traz a organização do Zitadel (o provider) e
as roles por organização. O `providerId` de uma transação precisa ser o do token, e as consultas por
provider respeitam o mesmo limite. Com `AUTH_MODE=disabled`, as rotas abrem sem usuário: esse é o ponto
de extensão pedido pelo enunciado para quando não há autenticação. Mensagens da fila são entrada interna
confiável, mas o `providerId` delas passa pela validação de domínio.

## Decisões e trade-offs

- **Lock pessimista por carteira** em vez de otimista: correção mais simples de provar com várias
  instâncias, ao custo de espera em carteiras quentes (limitada por `lock_timeout`).
- **`bigint` em centavos** em vez de `numeric`: aritmética exata em TypeScript sem biblioteca decimal,
  e o banco continua sendo a fonte da verdade.
- **Carteiras não são escopadas por provider:** o enunciado define carteira por jogador e moeda;
  um jogador usa a mesma carteira em vários providers.
- **Games:** catálogo somente leitura, isolado. A transação aceita `gameId` só como informação
  (relatórios); ele não é validado nem bloqueia o processamento, para não criar dependências fora do
  contrato do desafio.
- **Testes com o cliente nativo do Bun (opcional):** os repositórios dependem só de uma porta
  `SqlExecutor`; com `TEST_DB_DRIVER=bun-sql`, os testes de integração usam o cliente PostgreSQL do Bun
  em vez do MikroORM, com os mesmos repositórios e o mesmo banco real.

## Limitações conhecidas

- **Métricas** ficam em memória, por instância; o Prometheus soma as instâncias. Reiniciar zera os contadores.
- **Publicador do outbox** mantém o lock do lote durante o envio ao SQS. Lotes de 100 em chamadas de 10
  limitam o tempo de lock; uma alternativa seria marcar o lote como reservado com prazo (lease) e enviar fora
  da transação.
- **Ordem dos eventos entre instâncias:** dentro de um lote, os eventos de uma carteira saem em ordem; dois
  publicadores com lotes diferentes podem intercalar eventos da mesma carteira. O consumidor ordena por
  `walletVersion` (presente em `WalletBalanceChanged`) e deduplica por `eventId`.
- **`idempotency_keys` e `inbox_messages`** crescem sem limpeza. Em produção, uma rotina removeria
  registros mais antigos que a janela de reentrega dos providers.
- **ROLLBACK de um REFUND** debita de novo o valor, mas o BET original continua marcado como revertido;
  um novo REFUND desse BET é recusado (`ALREADY_REVERSED`).
- **Estado FAILED** existe na máquina de estados, mas o consumidor manda mensagens irrecuperáveis direto
  para a DLQ, sem criar transação (elas não têm dados válidos para isso).
- **Partidas dobradas (double-entry)** não foram implementadas (opcional no enunciado). O ledger é
  de entrada simples por carteira, com `balance_after` e versão contínua.
