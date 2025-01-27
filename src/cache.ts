import { Event, Hex } from "@/types";

export interface Cache {
  insertEvents(args: {
    chainId: number;
    events: Event[];
    address: Hex;
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<void>;
  getEvents(args: {
    chainId: number;
    address: Hex;
    topic0?: Hex;
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<{ fromBlock: bigint; toBlock: bigint; events: Event[] } | null>;
  getContractRead(args: {
    chainId: number;
    address: Hex;
    data: Hex;
    functionName: string;
    blockNumber: bigint;
  }): Promise<Hex | null>;
  insertContractRead(args: {
    chainId: number;
    address: Hex;
    data: Hex;
    functionName: string;
    blockNumber: bigint;
    result: Hex;
  }): Promise<void>;
}
