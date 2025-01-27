import { Abi, ExtractAbiEventNames, ExtractAbiFunctionNames } from "abitype";
import { decodeFunctionResult, encodeFunctionData, getAddress } from "viem";

import { RpcClient } from "@/rpc";
import { Cache } from "@/cache";
import { Logger, LoggerBackend, LogLevel } from "@/logger";
import { createEventQueue } from "@/eventQueue";
import {
  Hex,
  ToBlock,
  EventHandler,
  ReadContractParameters,
  ReadContractReturn,
  UnionToIntersection,
} from "@/types";
import { SubscriptionStore } from "@/subscriptionStore";
import {
  Subscription,
  saveSubscriptionsToStore,
  updateSubscription,
  getSubscriptionEvents,
} from "@/subscriptions";
import { AsyncEventEmitter } from "@/asyncEventEmitter";
import { processEvents } from "@/eventProcessor";

export type Config<TAbis extends Record<string, Abi>, TContext = unknown> = {
  contracts: TAbis;
  chain: {
    id: number;
    rpcClient: RpcClient;
    pollingIntervalMs?: number;
  };
  context?: TContext;
  logLevel?: keyof typeof LogLevel;
  logger?: LoggerBackend;
  cache?: Cache | null;
  subscriptionStore?: SubscriptionStore;
};

export type IndexerEvents<TAbis extends Record<string, Abi>, TContext> = {
  stopped: () => void;
  started: () => void;
  error: (err: unknown) => void;
  progress: (args: {
    currentBlock: bigint;
    targetBlock: bigint;
    pendingEventsCount: number;
  }) => void;
  event: EventHandler<TAbis, TContext>;
};

export interface Indexer<
  TAbis extends Record<string, Abi> = Record<string, Abi>,
  TContext = unknown
> extends AsyncEventEmitter<
    IndexerEvents<TAbis, TContext> & IndexerContractEvents<TAbis, TContext>
  > {
  context?: TContext;

  indexToBlock(toBlock: ToBlock): Promise<void>;
  watch(): void;

  stop(): Promise<void>;

  subscribeToContract(options: {
    contract: keyof TAbis;
    address: string;
    indexedToBlock?: bigint;
    fromBlock?: bigint;
    fromLogIndex?: number;
    toBlock?: ToBlock;
    id?: string;
  }): void;

  readContract<
    TContractName extends keyof TAbis,
    TFunctionName extends ExtractAbiFunctionNames<
      TAbis[TContractName],
      "pure" | "view"
    >
  >(
    args: {
      contract: TContractName;
      functionName: TFunctionName;
    } & ReadContractParameters<TAbis, TContractName>
  ): Promise<ReadContractReturn<TAbis[TContractName], TFunctionName>>;
}

type InitialIndexerState = {
  type: "initial";
};

type StoppedIndexerState = {
  type: "stopped";
};

type RunningIndexerState = {
  type: "running";
  pollTimeout: NodeJS.Timeout;
  targetBlock: ToBlock;
  onError: (error: unknown) => void;
  onStop: () => void;
};

type IndexerState =
  | RunningIndexerState
  | StoppedIndexerState
  | InitialIndexerState;

export function createIndexer<
  TAbis extends Record<string, Abi> = Record<string, Abi>,
  TContext = unknown
>(config: Config<TAbis, TContext>): Indexer<TAbis, TContext> {
  const eventEmitter = new AsyncEventEmitter<IndexerEvents<TAbis, TContext>>();
  const eventPollDelayMs = config.chain.pollingIntervalMs ?? 1000;
  const logLevel: LogLevel = LogLevel[config.logLevel ?? "warn"];

  if (logLevel === undefined) {
    throw new Error(`Invalid log level: ${config.logLevel}`);
  }

  const loggerBackend: LoggerBackend =
    config.logger ??
    ((level, msg, data) => {
      console.log(`[${level}]`, msg, JSON.stringify(data));
    });

  const logger = new Logger(logLevel, loggerBackend);
  const cache = config.cache ?? null;
  const rpcClient = config.chain.rpcClient;

  let state: IndexerState = {
    type: "initial",
  };

  const contracts = config.contracts;
  const subscriptions: Map<string, Subscription> = new Map();
  const eventQueue = createEventQueue();

  async function poll() {
    if (state.type !== "running") {
      return;
    }

    function scheduleNextPoll(delay = eventPollDelayMs) {
      if (state.type === "running") {
        state.pollTimeout = setTimeout(poll, delay);
      }
    }

    try {
      let targetBlock: bigint;

      //  latest is a moving target
      if (state.targetBlock === "latest") {
        targetBlock = await rpcClient.getLastBlockNumber();
      } else {
        targetBlock = state.targetBlock;
      }

      await getSubscriptionEvents({
        chainId: config.chain.id,
        targetBlock,
        subscriptions,
        rpc: rpcClient,
        cache: cache,
        pushEvent(event) {
          eventQueue.queue(event);
        },
        logger,
      });

      const subscriptionIds = Array.from(subscriptions.keys());

      for (const id of subscriptionIds) {
        updateSubscription(subscriptions, id, { fetchedToBlock: targetBlock });
      }

      const { indexedToBlock, indexedToLogIndex, hasNewSubscriptions } =
        await processEvents({
          chainId: config.chain.id,
          eventQueue,
          targetBlock,
          subscriptions,
          contracts,
          logger,
          eventEmitter,
          context: config.context,
          readContract: readContract,
          subscribeToContract: subscribeToContract,
        });

      for (const id of subscriptionIds) {
        updateSubscription(subscriptions, id, {
          indexedToBlock,
          indexedToLogIndex,
        });
      }

      if (hasNewSubscriptions) {
        if (config.subscriptionStore) {
          await saveSubscriptionsToStore(
            config.subscriptionStore,
            subscriptions
          );
        }
        scheduleNextPoll(0);
        return;
      }

      for (const id of subscriptionIds) {
        updateSubscription(subscriptions, id, {
          indexedToBlock: targetBlock,
          indexedToLogIndex: 0,
        });
      }

      // report progress when we reach the target block
      eventEmitter.emit("progress", {
        currentBlock: indexedToBlock,
        targetBlock: targetBlock,
        pendingEventsCount: eventQueue.size(),
      });

      logger.trace(`Indexed to block ${targetBlock}`);

      if (config.subscriptionStore) {
        await saveSubscriptionsToStore(config.subscriptionStore, subscriptions);
      }

      // stop th eindexer if we reached the final target block
      if (state.targetBlock !== "latest" && targetBlock === state.targetBlock) {
        logger.trace("Reached indexing target block");
        stop();
        return;
      }
    } catch (err) {
      state.onError(err);
    }

    scheduleNextPoll();
  }

  const subscribeToContract: Indexer<TAbis, TContext>["subscribeToContract"] = (
    subscribeOptions
  ) => {
    const { contract: contractName } = subscribeOptions;
    const address = getAddress(subscribeOptions.address);
    const contract = contracts[contractName];

    if (!contract) {
      throw new Error(`Contract ${String(contractName)} not found`);
    }

    logger.trace(
      `Subscribing to ${String(contractName)} ${
        subscribeOptions.address
      } from ${subscribeOptions.fromBlock ?? 0}`
    );

    const id = address;

    const fromBlock = subscribeOptions.fromBlock ?? 0n;

    const subscription: Subscription = {
      id: id,
      abi: contract,
      contractName: String(contractName),
      contractAddress: address,
      fromBlock: fromBlock,
      toBlock: subscribeOptions.toBlock ?? "latest",
      indexedToBlock: subscribeOptions.indexedToBlock ?? fromBlock - 1n,
      fetchedToBlock: -1n,
      indexedToLogIndex: 0,
    };

    subscriptions.set(id, subscription);
  };

  async function init() {
    if (config.subscriptionStore) {
      const storedSubscriptions = await config.subscriptionStore.all();

      for (const subscription of storedSubscriptions) {
        subscribeToContract({
          contract: subscription.contractName as keyof TAbis,
          id: subscription.id,
          address: subscription.contractAddress,
          indexedToBlock: subscription.indexedToBlock,
          fromBlock: subscription.fromBlock,
          fromLogIndex: subscription.indexedToLogIndex,
          toBlock: subscription.toBlock,
        });
      }

      logger.info(`Loaded ${subscriptions.size} subscriptions from store`);
    }
  }

  async function stop() {
    if (state.type !== "running") {
      throw new Error("Indexer is not running");
    }

    logger.trace("Stopping indexer");

    clearTimeout(state.pollTimeout);
    eventEmitter.emit("stopped");
    state.onStop?.();

    state = {
      type: "stopped",
    };
  }

  async function readContract<
    TContractName extends keyof TAbis,
    TFunctionName extends ExtractAbiFunctionNames<
      TAbis[TContractName],
      "pure" | "view"
    >
  >(
    args: {
      contract: TContractName;
      functionName: TFunctionName;
    } & ReadContractParameters<TAbis, TContractName>
  ): Promise<ReadContractReturn<TAbis[TContractName], TFunctionName>> {
    const contract = contracts[args.contract];

    if (contract === undefined) {
      throw new Error(`Contract ${String(args.contract)} not found`);
    }

    const data = encodeFunctionData({
      abi: contract as Abi,
      functionName: args.functionName as string,
      args: args.args as unknown[],
    });

    let result: Hex | undefined;

    if (cache) {
      const cachedRead = await cache.getContractRead({
        chainId: config.chain.id,
        address: args.address,
        blockNumber: args.blockNumber,
        functionName: args.functionName,
        data: data,
      });

      if (cachedRead !== null) {
        result = cachedRead;
      }
    }

    if (result === undefined) {
      result = await rpcClient.readContract({
        functionName: args.functionName,
        data: data,
        address: args.address,
        blockNumber: args.blockNumber,
      });

      if (cache) {
        await cache.insertContractRead({
          chainId: config.chain.id,
          address: args.address,
          blockNumber: args.blockNumber,
          functionName: args.functionName,
          data: data,
          result,
        });
      }
    }

    return decodeFunctionResult({
      abi: contract as Abi,
      functionName: args.functionName as string,
      data: result,
    }) as ReadContractReturn<TAbis[TContractName], TFunctionName>;
  }

  return Object.setPrototypeOf(
    {
      context: config.context,
      subscribeToContract,
      stop,

      readContract,

      watch() {
        const initPromise =
          state.type === "initial" ? init() : Promise.resolve();

        initPromise
          .then(() => {
            if (state.type === "running") {
              throw new Error("Indexer is already running");
            }

            logger.trace(`Watching chain for events`);

            state = {
              type: "running",
              targetBlock: "latest",
              // eslint-disable-next-line @typescript-eslint/no-empty-function
              onStop: () => {},
              onError: (error) => {
                eventEmitter.emit("error", error);
              },
              pollTimeout: setTimeout(poll, 0),
            };

            eventEmitter.emit("started");
          })
          .catch((error) => {
            eventEmitter.emit("error", error);
          });
      },

      async indexToBlock(target: ToBlock): Promise<void> {
        if (state.type === "initial") {
          await init();
        }

        if (state.type === "running") {
          throw new Error("Indexer is already running");
        }

        let targetBlock: bigint;

        if (target === "latest") {
          targetBlock = await rpcClient.getLastBlockNumber();
        } else {
          targetBlock = target;
        }

        logger.trace(`Indexing to block ${targetBlock}`);

        return new Promise((resolve, reject) => {
          state = {
            type: "running",
            targetBlock: targetBlock,
            onStop: () => {
              resolve();
            },
            onError: (error) => {
              reject(error);
              stop();
            },
            pollTimeout: setTimeout(poll, 0),
          };
          eventEmitter.emit("started");
        });
      },
    },
    eventEmitter
  );
}

// helper that returns a type that looks like this:
// {
//  "ContractName:EventName": EventHandler,
//  "ContractName2:EventName2": EventHandler2,
//  ..
// }
export type IndexerContractEvents<
  TAbis extends Record<string, Abi>,
  TContext
> = UnionToIntersection<
  {
    [K in keyof TAbis]: {
      [N in ExtractAbiEventNames<TAbis[K]> as `${K & string}:${N &
        string}`]: EventHandler<TAbis, TContext, TAbis[K], N>;
    };
  }[keyof TAbis]
>;
