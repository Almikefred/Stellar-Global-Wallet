import * as StellarSdk from "@stellar/stellar-sdk";
import { buildRestoreTransaction, SorobanService } from "../../src/services/soroban";

const { rpc } = StellarSdk;
const CONTRACT_ID = "CBGLPMNSM4FWMIZ6FFBSRN7FNVCHCI2SLZNODA27LEOXFPLWNYEAEP3K";

function restoreSimulation(): StellarSdk.rpc.Api.SimulateTransactionRestoreResponse {
  return {
    id: "1",
    latestLedger: 1000,
    events: [],
    _parsed: true,
    transactionData: new StellarSdk.SorobanDataBuilder(),
    minResourceFee: "100",
    cost: { cpuInsns: "0", memBytes: "0" },
    result: { auth: [], retval: StellarSdk.xdr.ScVal.scvVoid() },
    restorePreamble: { minResourceFee: "5000", transactionData: new StellarSdk.SorobanDataBuilder() },
  } as StellarSdk.rpc.Api.SimulateTransactionRestoreResponse;
}

describe("buildRestoreTransaction (#185)", () => {
  it("builds a single RestoreFootprint op with preamble fee added", () => {
    const account = new StellarSdk.Account(StellarSdk.Keypair.random().publicKey(), "10");
    const tx = buildRestoreTransaction(
      account,
      { minResourceFee: "5000", transactionData: new StellarSdk.SorobanDataBuilder() },
      StellarSdk.Networks.TESTNET
    );
    expect(tx.operations).toHaveLength(1);
    expect(tx.operations[0].type).toBe("restoreFootprint");
    expect(tx.fee).toBe(String(Number(StellarSdk.BASE_FEE) + 5000));
    expect(tx.sequence).toBe("11");
  });
});

describe("SorobanService.prepareInvocation with archived footprint (#185)", () => {
  afterEach(() => jest.restoreAllMocks());

  it("returns a restore tx at n+1 and the invocation at n+2", async () => {
    const publicKey = StellarSdk.Keypair.random().publicKey();
    jest
      .spyOn(rpc.Server.prototype, "getAccount")
      .mockResolvedValue(new StellarSdk.Account(publicKey, "100"));
    jest.spyOn(rpc.Server.prototype, "simulateTransaction").mockResolvedValue(restoreSimulation());

    const prepared = await new SorobanService().prepareInvocation({
      contractId: CONTRACT_ID,
      method: "record_spend",
      args: [],
      sourcePublicKey: publicKey,
    });

    expect(prepared.restore).toBeDefined();
    const restoreTx = new StellarSdk.Transaction(prepared.restore!.transactionXdr, StellarSdk.Networks.TESTNET);
    expect(restoreTx.sequence).toBe("101");
    expect(restoreTx.operations[0].type).toBe("restoreFootprint");
    const mainTx = new StellarSdk.Transaction(prepared.xdr, StellarSdk.Networks.TESTNET);
    expect(mainTx.sequence).toBe("102");
  });
});
