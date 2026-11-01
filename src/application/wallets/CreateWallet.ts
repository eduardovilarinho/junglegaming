import { createHash } from "node:crypto";
import { Currency, Money } from "../../domain/shared/Money";
import { WagerTransaction } from "../../domain/wagering/WagerTransaction";
import { Wallet } from "../../domain/wallet/Wallet";
import { DuplicateWalletError, UniqueViolationError } from "../errors";
import type { Clock, UnitOfWork } from "../ports";
import { walletView, type WalletView } from "../views";

export interface CreateWalletCommand {
    readonly playerId: string;
    readonly currency: string;
    /** String decimal; vazio ou "0" = sem saldo inicial */
    readonly initialBalance: string | null;
}

// Cria a carteira. Com saldo inicial positivo, cria também a transação interna OPENING
// e o crédito no ledger, tudo na mesma transação SQL.
// A transação OPENING usa o saldo inicial como valor; o ledger recebe o crédito com saldo anterior 0.
export class CreateWallet {
    constructor(
        private readonly uow: UnitOfWork,
        private readonly clock: Clock
    ) {}

    async execute(c: CreateWalletCommand): Promise<WalletView> {
        const moeda = Currency.of(c.currency);
        const inicial = Money.fromDecimal(c.initialBalance ?? "0", moeda);
        const agora = this.clock();
        const id = crypto.randomUUID();

        // Sem saldo inicial: só a carteira (versão 1). Com saldo: carteira, transação OPENING,
        // lançamento de crédito e evento, tudo na mesma transação SQL. A versão continua 1.
        const abertura = inicial.isPositive()
            ? WagerTransaction.opening({
                  walletId: id,
                  playerId: c.playerId,
                  amount: inicial,
                  requestHash: createHash("sha256").update("opening:" + id + ":" + inicial.toDecimalString()).digest("hex"),
                  now: agora,
              })
            : null;
        const criada =
            abertura === null
                ? { wallet: Wallet.open({ id, playerId: c.playerId, currency: moeda, now: agora }), opening: null }
                : Wallet.openWithInitialBalance({ id, playerId: c.playerId, initialBalance: inicial, openingTransactionId: abertura.id, now: agora });
        const carteira = criada.wallet;

        try {
            await this.uow.run(async (ctx) => {
                await ctx.wallets.insert(carteira);
                if (abertura === null || criada.opening === null) return;
                await ctx.transactions.insert(abertura);
                await ctx.ledger.append(criada.opening.entry);
                await ctx.outbox.add([criada.opening.event]);
            });
        } catch (erro: unknown) {
            if (erro instanceof UniqueViolationError && erro.constraint === "wallets_player_currency_unique") {
                throw new DuplicateWalletError("O jogador " + c.playerId + " já tem carteira em " + moeda.code);
            }
            throw erro;
        }
        return walletView(carteira);
    }
}
