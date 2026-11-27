import {describe} from "vitest";
import {memoryReplayStore} from "./memoryReplayStore";
import {replayStoreContract} from "./replayStoreContract";

describe("the in-memory replay store", () => {
  const store = memoryReplayStore();
  replayStoreContract(() => store);
});
