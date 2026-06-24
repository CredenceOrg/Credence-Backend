import { AsyncLocalStorage } from "node:async_hooks";

const ALS = new AsyncLocalStorage<Map<string, string>>();

export function runWithTenant<T>(tenantId: string, fn: () => T): T {
  const store = new Map<string, string>();
  store.set("tenantId", tenantId);
  return ALS.run(store, fn);
}

export function getTenantId(): string | undefined {
  const store = ALS.getStore();
  return store?.get("tenantId");
}

export function setTenantId(tenantId: string | null): void {
  const store = ALS.getStore();
  if (!store) return;
  if (tenantId === null) {
    store.delete("tenantId");
  } else {
    store.set("tenantId", tenantId);
  }
}

export default {
  runWithTenant,
  getTenantId,
  setTenantId,
};
