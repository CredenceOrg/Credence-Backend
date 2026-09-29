// src/db/repository.ts
export const dbRepository = {
  upsertNode: async (nodeId: string, amount: string): Promise<boolean> => {
    // Real implementation would connect to the DB here
    return true;
  },
  updateNodeStatus: async (nodeId: string, status: string, amount?: string): Promise<boolean> => {
    // Real implementation would update the DB here
    return true;
  },
  /**
   * Reads the current ingestion lifecycle state for a node.
   *
   * Returns `null` when the node has never been ingested (no `bond` event
   * seen yet). `HorizonListener.handleEvent` uses this as the read half of
   * its read-validate-write transition enforcement; the default stub refuses
   * to manufacture state, so callers must supply a real repository.
   */
  getNodeStatus: async (_nodeId: string): Promise<string | null> => {
    // Real implementation would query the node status here
    return null;
  }
};
