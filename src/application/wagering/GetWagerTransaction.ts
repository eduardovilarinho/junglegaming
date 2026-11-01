import { isUuid } from "../../domain/shared/identifiers";
import { NotFoundError } from "../errors";
import type { UnitOfWork } from "../ports";
import { transactionView, type TransactionView } from "../views";

export class GetWagerTransaction {
    constructor(private readonly uow: UnitOfWork) {}

    async byId(id: string): Promise<TransactionView> {
        if (!isUuid(id)) throw new NotFoundError("Transação " + id + " não encontrada");
        const t = await this.uow.run((ctx) => ctx.transactions.findById(id));
        if (t === null) throw new NotFoundError("Transação " + id + " não encontrada");
        return transactionView(t);
    }

    async byExternalId(providerId: string, externalTransactionId: string): Promise<TransactionView> {
        const t = await this.uow.run((ctx) => ctx.transactions.findByExternalId(providerId, externalTransactionId));
        if (t === null) {
            throw new NotFoundError("Transação " + externalTransactionId + " do provider " + providerId + " não encontrada");
        }
        return transactionView(t);
    }
}
