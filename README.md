# Jungle Gaming — Wagering Wallet Service

Serviço financeiro distribuído que processa transações de aposta (BET, WIN, LOSS, REFUND, ROLLBACK)
vindas de vários providers, por HTTP e por fila SQS, mantendo o saldo de cada carteira sempre igual
ao ledger, mesmo com mensagens duplicadas, fora de ordem, concorrentes e com falhas no meio.

Stack: **Bun 1.x** (runtime, pacotes e testes) · **NestJS** · **TypeScript estrito** · **PostgreSQL** ·
**MikroORM** · **SQS** (MiniStack local) · **Docker Compose** · autenticação opcional com **Zitadel**.

As decisões de projeto, trade-offs e limitações estão em [ARCHITECTURE.md](ARCHITECTURE.md).

## Requisitos

- [Bun](https://bun.sh) 1.2 ou mais recente
- Docker com Docker Compose

## Início rápido

```bash
bun install
cp .env.example .env          # Windows: copy .env.example .env
bun run infra:up              # PostgreSQL + MiniStack (SQS)
bun run db:migrate            # cria as tabelas
bun run sqs:setup             # cria as filas FIFO e a DLQ
bun run start:dev             # API em http://localhost:3000
```

Para usar sem token, defina `AUTH_MODE=disabled` no `.env` (veja [Autenticação](#autenticação)).

### Três instâncias com Docker

```bash
bun install                   # gera o bun.lock usado na imagem
bun run app:up                # PostgreSQL, MiniStack, migração, filas e 3 instâncias da API
```

As instâncias respondem em `http://localhost:3001`, `3002` e `3003`, todas com consumidor da fila,
publicador do outbox e worker de pendências ligados, e `AUTH_MODE=disabled`.

## Testes

```bash
bun run typecheck             # TypeScript estrito em src e test
bun test                      # unitários + e2e (sem infraestrutura)
bun run test:integration      # PostgreSQL real (bun run infra:up antes)
bun run test:multi            # 3 instâncias da API + PostgreSQL + MiniStack reais
```

| Suite | O que cobre | Infra |
|---|---|---|
| `test/unit` | Money, invariantes da carteira, regras de cada operação, máquina de estados, conflito de moeda, hash canônico da idempotência, cursor, métricas | nenhuma |
| `test/app.e2e.spec.ts`, `test/zitadel-validador.spec.ts` | autenticação, health, métricas, tradução das claims do Zitadel | nenhuma |
| `test/integration/financeiro` | constraints do schema (inclusive a aritmética do ledger), atomicidade, idempotência e saldo devolvido na repetição, inbox, **50 BETs idênticos em paralelo**, **saldo 100.00 com dois BETs simultâneos de 80.00**, disputa na mesma carteira, carteiras em paralelo, reversões concorrentes, referência fora de ordem, workers concorrentes, outbox com publicadores concorrentes e falha parcial no lote, paginação, reconciliação | PostgreSQL |
| `test/integration/http` | contrato HTTP (formato do enunciado): status, `Idempotency-Key`, `idempotentReplay` com o saldo original, 409, 422, 202, 404, cursor, reconciliação, provider do token | PostgreSQL |
| `test/integration/multi-instancia` | 3 processos da API: BETs idênticos e disputa entre instâncias, fila com duplicatas (mesmo `messageId` e reenvio) e fora de ordem, **processo morto depois do commit e antes do ack**, reinício, mensagem inválida na DLQ, eventos publicados sem repetição | PostgreSQL + MiniStack |

Todo teste de integração termina conferindo o invariante final: o saldo de cada carteira é igual ao
saldo reconstruído a partir do ledger.

Os testes de integração usam um banco separado (`jungle_gaming_test`, criado sozinho).
Para outro endereço, defina `TEST_DATABASE_URL`. Por padrão as transações são abertas pelo MikroORM,
como em produção; `TEST_DB_DRIVER=bun-sql` usa o cliente PostgreSQL nativo do Bun com os mesmos repositórios.

### Teste de carga (bônus)

```bash
bun run app:up                # 3 instâncias (ou: AUTH_MODE=disabled bun run start, para 1)
LOAD_URLS=http://localhost:3001,http://localhost:3002,http://localhost:3003 \
  LOAD_DURATION_S=20 LOAD_CONCURRENCY=50 LOAD_WALLETS=20 bun run test:load
```

**Metodologia** (detalhes no cabeçalho de `test/load/load-test.ts`): 50 trabalhadores em laço fechado
disparam BETs de 0.01 por 20 s, em rodízio entre as instâncias. 10% dos pedidos repetem um pedido anterior
idêntico (mesma `Idempotency-Key` e mesmo corpo). A latência é medida no cliente. Antes e depois, o script lê
`/metrics` de cada instância (retentativas, locks esgotados, repetições). No fim, espera o outbox esvaziar e
reconcilia todas as carteiras.

**Resultados de referência.** Máquina de 2 vCPUs em que tudo divide a mesma CPU: as instâncias da API,
o PostgreSQL 16, o MiniStack e o próprio gerador de carga. Bun 1.4.4, sem Docker.

| Cenário | Vazão | p50 | p95 | p99 | Erros | Outbox: maior atraso / esvaziou em |
|---|---|---|---|---|---|---|
| 1 instância, 20 carteiras | 552 req/s | 87 ms | 127 ms | 152 ms | 0% | 14,6 s / 35 s |
| 3 instâncias, 20 carteiras | 387 req/s | 113 ms | 272 ms | 363 ms | 0% | 9,0 s / 13 s |
| 3 instâncias, 2 carteiras (disputa) | 244 req/s | 166 ms | 494 ms | 812 ms | 0% | 1,8 s / 1 s |

Em todos os cenários: 100% de respostas 201, todas as repetições respondidas como replay sem novo débito,
nenhuma retentativa nem lock esgotado, e todas as carteiras consistentes na reconciliação.

**Análise:**
- **3 instâncias não aumentam a vazão aqui** porque não há CPU livre: com 2 vCPUs, mais processos só
  disputam o mesmo processador e pioram a cauda (p99). O ganho horizontal aparece com instâncias em
  máquinas separadas. O que este teste mostra é a correção com várias instâncias, não a escala.
- **Disputa pela mesma carteira:** com 2 carteiras, 25 trabalhadores esperam o lock de cada uma.
  O lock por carteira serializa essas operações: a vazão cai pela metade e o p99 passa de 800 ms,
  mas nenhum pedido estourou o `LOCK_TIMEOUT_MS` (5 s). Carteiras diferentes não se bloqueiam.
- **O outbox atrasa por causa do MiniStack, não do banco:** medido à parte, o emulador aceita cerca de
  200 mensagens/s mesmo com `SendMessageBatch`, e cada BET gera 2 eventos. Com 500 req/s, a fila de eventos
  não acompanha durante a carga e esvazia depois, sem perder nenhum evento. No cenário de disputa, com menos
  BETs por segundo, o atraso fica abaixo de 2 s. Contra o SQS real, o limite seria outro e precisaria ser medido.
- **Limites desta medição:** uma única máquina pequena, emulador no lugar do SQS e execuções curtas de 20 s
  (sem aquecimento separado). Servem para comparar cenários entre si, não como capacidade de produção.

## Endpoints

| Método e rota | Descrição | Respostas |
|---|---|---|
| `POST /wallets` | Cria carteira (`version` 1). `initialBalance` positivo gera a transação interna OPENING e o crédito no ledger, no mesmo commit; sem ele, informe `currency` | 201 · 400 · 409 (jogador já tem carteira na moeda) |
| `GET /wallets/:walletId` | Carteira e saldo | 200 · 404 |
| `GET /wallets/:walletId/ledger?limit=&cursor=` | Ledger com cursor opaco e estável | 200 · 400 (cursor inválido) · 404 |
| `POST /wallets/:walletId/reconciliation` | Compara saldo e ledger; divergência é registrada, logada e contada, nunca corrigida | 200 · 404 |
| `POST /wagering/transactions` | Processa uma transação. Cabeçalho `Idempotency-Key` obrigatório | 201 processada · 202 aguardando referência · 422 rejeição de negócio (`failureCode`) · 400 · 409 conflito de idempotência · 503 falha passageira |
| `GET /wagering/transactions/:transactionId` | Consulta por id interno | 200 · 404 |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | Consulta pelo id do provider | 200 · 404 |
| `GET /health/live` · `GET /health/ready` | Liveness e readiness (PostgreSQL e SQS), sem autenticação | 200 · 503 |
| `GET /metrics` | Métricas no formato do Prometheus, sem autenticação | 200 |

Dinheiro é sempre um objeto `{"amount": "10.50", "currency": "BRL"}`, com o valor como string.
A resposta de uma transação traz `transactionId`, `status`, `failureCode`, `balance` (saldo observado ao
concluir) e `idempotentReplay`. Pedido repetido com a mesma `Idempotency-Key` e o mesmo conteúdo devolve o
mesmo status e corpo, inclusive o saldo daquele momento, com `"idempotentReplay": true` e o cabeçalho
`Idempotent-Replayed: true`. Erros têm corpo
`{"statusCode", "error", "message"}`, com `error` estável (`INVALID_PAYLOAD`, `IDEMPOTENCY_CONFLICT`, ...).
A tabela completa de códigos está em [ARCHITECTURE.md](ARCHITECTURE.md#taxonomia-de-falhas).

### Exemplo

```bash
# Carteira com saldo inicial (valores sempre como string decimal)
curl -s -X POST http://localhost:3000/wallets -H "Content-Type: application/json" \
  -d '{"playerId":"player-1","initialBalance":{"amount":"100.00","currency":"BRL"}}'

# BET (troque WALLET_ID)
curl -s -X POST http://localhost:3000/wagering/transactions \
  -H "Content-Type: application/json" -H "Idempotency-Key: prov-1:bet-1" \
  -d '{"providerId":"prov-1","externalTransactionId":"bet-1","kind":"BET","playerId":"player-1","walletId":"WALLET_ID","roundId":"round-1","gameId":"fortune-chimp","money":{"amount":"10.00","currency":"BRL"}}'

# ROLLBACK do BET
curl -s -X POST http://localhost:3000/wagering/transactions \
  -H "Content-Type: application/json" -H "Idempotency-Key: prov-1:rb-1" \
  -d '{"providerId":"prov-1","externalTransactionId":"rb-1","kind":"ROLLBACK","playerId":"player-1","walletId":"WALLET_ID","roundId":"round-1","money":{"amount":"10.00","currency":"BRL"},"referenceExternalTransactionId":"bet-1"}'

# Pela fila: o JSON vira o campo "data" do envelope {messageId, type, occurredAt, data}
# (MessageGroupId = carteira; um segundo argumento opcional fixa o messageId)
bun run sqs:send '{"providerId":"prov-1","externalTransactionId":"bet-2","kind":"BET","playerId":"player-1","walletId":"WALLET_ID","roundId":"round-2","money":{"amount":"5.00","currency":"BRL"}}'
```

No Windows (PowerShell ou cmd), troque as aspas simples externas por aspas duplas e escape as internas,
ou use um cliente HTTP.

## Autenticação

A autenticação foi implementada com um provedor de identidade externo
(**Zitadel**) e pode ser desligada:

- `AUTH_MODE=zitadel` (padrão): toda rota exige `Authorization: Bearer <token>`, exceto health e métricas.
  O provider do token precisa ser o mesmo `providerId` da transação (senão, 403).
- `AUTH_MODE=disabled`: rotas abertas, sem usuário. É o ponto de extensão para avaliação local e para os
  testes de várias instâncias. Mensagens da fila são entrada interna confiável, mas o `providerId` delas
  passa pela validação de domínio.

> [!NOTE]
> Instância do Zitadel criada só para este desafio, com um service user exclusivo para a avaliação.
> A credencial será revogada após o processo.

> [!WARNING]
> Em um projeto real, esta credencial ficaria fora do repositório.

```bash
TOKEN=$(curl -s -X POST "https://jungle-gaming-zyp2xj.us1.zitadel.cloud/oauth/v2/token" \
  -u "api-tester:mPOsbMOjKbazEjxMAXhAeQ7JwkGspUQRi1ZHQkgis9mj6DUAHlORFpQASDba75Gy" \
  -d "grant_type=client_credentials" \
  -d "scope=openid urn:zitadel:iam:user:resourceowner urn:zitadel:iam:org:projects:roles urn:zitadel:iam:org:project:id:397556188520177511:aud" \
  | jq -r .access_token)

curl http://localhost:3000/me -H "Authorization: Bearer $TOKEN"
```

O `providerId` dessa credencial é o id da organização no Zitadel (`397555803785125735`); use esse valor
no campo `providerId` das transações enviadas com o token.

## Configuração

Todas as variáveis, com valores padrão e comentários, estão em [`.env.example`](.env.example).
O Bun carrega o `.env` sozinho; variáveis do sistema têm prioridade.

### HTTPS local (opcional)

```bash
mkcert -install && mkdir certs
mkcert -key-file certs/localhost-key.pem -cert-file certs/localhost.pem localhost 127.0.0.1 ::1
```

Depois descomente `HTTPS_KEY` e `HTTPS_CERT` no `.env`. No Windows, use `curl --ssl-revoke-best-effort`.

## Estrutura

```
src/
├── domain/              # Regras de negócio, sem framework nem banco
│   ├── shared/          # Money (bigint), Currency, DomainEvent, erros
│   ├── wallet/          # Wallet (agregado), LedgerEntry (imutável), WalletBalanceChanged
│   ├── wagering/        # WagerTransaction (máquina de estados), WagerSettlement (regras), FailureCode, eventos
│   ├── identidade/      # Usuario, Provedor (tenant), Role
│   └── games/           # Catálogo de games (somente leitura)
├── application/         # Casos de uso e portas (UnitOfWork, repositórios, Telemetry)
├── infrastructure/      # Adaptadores: SQL/MikroORM, SQS, Zitadel, health, logs JSON, métricas, config
├── interfaces/          # Entradas: HTTP (controllers, guards, filtro), fila (consumidor SQS), workers
└── modulos/             # Composição com módulos do NestJS
test/
├── unit/ · integration/ · load/ · support/
```

## Problemas comuns

| Sintoma | Causa |
|---|---|
| `relation "wallets" does not exist` | Migrações não aplicadas: `bun run db:migrate` |
| `/health/ready` responde 503 com `sqs: down` | MiniStack fora do ar ou filas não criadas: `bun run sqs:setup` |
| `ECONNREFUSED ...:5432` | PostgreSQL fora do ar: `bun run infra:up` |
| 401 em todas as rotas | `AUTH_MODE=zitadel` sem token; use um token ou `AUTH_MODE=disabled` |
| 403 em `POST /wagering/transactions` com token | `providerId` do corpo diferente do provider (organização) do token |
| `Instance not found` ao pegar o token | Domínio do Zitadel errado; confira a barra de endereço do console |
