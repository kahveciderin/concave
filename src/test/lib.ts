
import { EventSource } from "eventsource";

/* -----------------------------------------------------------
  Minimal “Convex-ish” ResourceRepository
  - Low-level CRUD/bulk ops are underscored: _create/_update/_delete/_list/_batch*
  - High-level create/update/get provide optimistic updates
  - get()/getById() return reactive objects (signal-backed) that update from:
      1) local optimistic writes
      2) server-sent subscription events
  - Assumes you have createResourceFilter(schema) somewhere; here we accept a filterer
    with execute(filterExpr, obj) -> boolean so optimistic membership works.
----------------------------------------------------------- */

/** ---------- tiny signal implementation ---------- */
type Unsub = () => void;

class Signal<T> {
  private listeners = new Set<(v: T) => void>();
  constructor(private _value: T) {}
  get value(): T {
    return this._value;
  }
  set value(v: T) {
    if (Object.is(v, this._value)) return;
    this._value = v;
    for (const fn of this.listeners) fn(v);
  }
  subscribe(fn: (v: T) => void): Unsub {
    this.listeners.add(fn);
    fn(this._value);
    return () => this.listeners.delete(fn);
  }
}

/** ---------- event model ---------- */
type SubscriptionEvent<T> =
  | { id: string; type: "existing"; object: T }
  | { id: string; type: "added"; object: T } // preferred over "new"
  | { id: string; type: "changed"; object: T }
  | { id: string; type: "removed"; objectId: string }
  | { id: string; type: "invalidate" }; // fallback when delta is impossible

/** ---------- transport abstraction (SSE/WebSocket/etc.) ---------- */
interface SubscriptionHandle {
  close(): void;
}

interface ResourceTransport<T> {
  /** Low-level HTTP-ish operations (your express routes) */
  create(resource: string, data: unknown): Promise<T>;
  update(resource: string, id: string, patch: unknown): Promise<T>;
  replace(resource: string, id: string, data: unknown): Promise<T>;
  delete(resource: string, id: string): Promise<void>;
  list(resource: string, filter?: string): Promise<T[]>;
  /** Optional: bulk endpoints */
  batchCreate?(resource: string, items: unknown[]): Promise<T[]>;
  batchUpdate?(resource: string, filter: string, patch: unknown): Promise<{ count: number }>;
  batchDelete?(resource: string, filter: string): Promise<{ count: number }>;

  /** Subscription: must deliver existing snapshot then deltas */
  subscribe(
    resource: string,
    filter: string,
    onEvent: (ev: SubscriptionEvent<T>) => void,
    onError?: (err: unknown) => void
  ): SubscriptionHandle;
}

/** ---------- filter interface (your createResourceFilter output-ish) ---------- */
interface Filterer<T> {
  execute(expr: string, object: T): boolean;
}

/** ---------- helpers ---------- */
function applyPatch<T extends Record<string, any>>(obj: T, patch: Partial<T>): T {
  return { ...obj, ...patch };
}

/** Reactive “doc” view */
class ReactiveDoc<T> {
  private sig: Signal<T | null>;
  constructor(sig: Signal<T | null>) {
    this.sig = sig;
  }
  get value(): T | null {
    return this.sig.value;
  }
  subscribe(fn: (v: T | null) => void): Unsub {
    return this.sig.subscribe(fn);
  }
}

/** Reactive “query” view */
class ReactiveQuery<T> {
  private itemsSig: Signal<T[]>;
  constructor(itemsSig: Signal<T[]>) {
    this.itemsSig = itemsSig;
  }
  get items(): T[] {
    return this.itemsSig.value;
  }
  subscribe(fn: (items: T[]) => void): Unsub {
    return this.itemsSig.subscribe(fn);
  }
}

/** ---------- main repository ---------- */
type IdOf<T> = (row: T) => string;

type OptimisticOp<T> =
  | { opId: string; kind: "create"; tempId: string; row: T }
  | { opId: string; kind: "update"; id: string; before: T; after: T }
  | { opId: string; kind: "delete"; id: string; before: T };

export class ResourceRepository<T extends Record<string, any>> {
  private store = new Map<string, T>();             // authoritative local cache
  private storeVersion = new Signal<number>(0);     // bumps whenever store changes
  private docs = new Map<string, Signal<T | null>>(); // per-id signals
  private queries = new Map<string, { sig: Signal<T[]>; sub?: SubscriptionHandle }>();

  private optimistic = new Map<string, OptimisticOp<T>>(); // opId -> op

  constructor(
    private readonly resource: string,
    private readonly idOf: IdOf<T>,
    private readonly transport: ResourceTransport<T>,
    private readonly filterer: Filterer<T>
  ) {}

  /* =========================
     LOW-LEVEL (underscore) API
     ========================= */

  async _create(data: unknown): Promise<T> {
    return this.transport.create(this.resource, data);
  }

  async _update(id: string, patch: unknown): Promise<T> {
    return this.transport.update(this.resource, id, patch);
  }

  async _replace(id: string, data: unknown): Promise<T> {
    return this.transport.replace(this.resource, id, data);
  }

  async _delete(id: string): Promise<void> {
    return this.transport.delete(this.resource, id);
  }

  async _list(filter = ""): Promise<T[]> {
    return this.transport.list(this.resource, filter);
  }

  async _batchCreate(items: unknown[]): Promise<T[]> {
    if (!this.transport.batchCreate) throw new Error("batchCreate not supported");
    return this.transport.batchCreate(this.resource, items);
  }

  async _batchUpdate(filter: string, patch: unknown): Promise<{ count: number }> {
    if (!this.transport.batchUpdate) throw new Error("batchUpdate not supported");
    return this.transport.batchUpdate(this.resource, filter, patch);
  }

  async _batchDelete(filter: string): Promise<{ count: number }> {
    if (!this.transport.batchDelete) throw new Error("batchDelete not supported");
    return this.transport.batchDelete(this.resource, filter);
  }

  /* =========================
     HIGH-LEVEL API (optimistic)
     ========================= */

  /** Reactive query; updates from both local optimistic writes and server subscription. */
  get(filter = ""): ReactiveQuery<T> {
    const key = filter || "";
    const existing = this.queries.get(key);
    if (existing) return new ReactiveQuery(existing.sig);

    const sig = new Signal<T[]>([]);
    this.queries.set(key, { sig });

    // Recompute when store changes (optimistic or server events)
    const recompute = () => {
      const rows: T[] = [];
      for (const row of this.store.values()) {
        if (!filter || this.filterer.execute(filter, row)) rows.push(row);
      }
      sig.value = rows;
    };
    this.storeVersion.subscribe(() => recompute());

    // Start server subscription (snapshot + deltas)
    const sub = this.transport.subscribe(
      this.resource,
      filter,
      (ev) => this.applyServerEvent(ev),
      (err) => {
        // in a real impl: backoff + retry, and maybe emit invalidate
        console.warn(`[${this.resource}] subscription error`, err);
      }
    );

    const entry = this.queries.get(key)!;
    entry.sub = sub;

    return new ReactiveQuery(sig);
  }

  /** Reactive single doc view. */
  getById(id: string): ReactiveDoc<T> {
    const sig = this.getDocSignal(id);
    return new ReactiveDoc(sig);
  }

  /** Optimistic create: immediate local insert; reconciles when server returns. */
  async create(input: unknown, opts?: { tempId?: string }): Promise<T> {
    const tempId = opts?.tempId ?? `temp_${cryptoRandomId()}`;
    const opId = `op_${cryptoRandomId()}`;

    // best effort: if input already includes id, use it; otherwise use temp id
    const optimisticRow = { ...(input as any), id: (input as any)?.id ?? tempId } as T;
    const optimisticId = this.idOf(optimisticRow);

    this.optimistic.set(opId, { opId, kind: "create", tempId: optimisticId, row: optimisticRow });
    this.upsertLocal(optimisticRow);

    try {
      const created = await this._create(input);
      const realId = this.idOf(created);

      // replace temp row with real row if id changed
      if (realId !== optimisticId) {
        this.deleteLocal(optimisticId);
      }
      this.upsertLocal(created);

      this.optimistic.delete(opId);
      return created;
    } catch (e) {
      // rollback
      this.deleteLocal(optimisticId);
      this.optimistic.delete(opId);
      throw e;
    }
  }

  /** Optimistic patch update; rolls back on failure. */
  async update(id: string, patch: Partial<T>): Promise<T> {
    const before = this.store.get(id);
    if (!before) throw new Error(`Cannot update missing ${this.resource}(${id})`);

    const opId = `op_${cryptoRandomId()}`;
    const after = applyPatch(before, patch);

    // If patch would change id, forbid (keep it simple)
    if (this.idOf(after) !== id) throw new Error("Changing primary key is not supported");

    this.optimistic.set(opId, { opId, kind: "update", id, before, after });
    this.upsertLocal(after);

    try {
      const saved = await this._update(id, patch);
      this.upsertLocal(saved);
      this.optimistic.delete(opId);
      return saved;
    } catch (e) {
      // rollback
      this.upsertLocal(before);
      this.optimistic.delete(opId);
      throw e;
    }
  }

  /** Optimistic delete; rolls back on failure. */
  async delete(id: string): Promise<void> {
    const before = this.store.get(id);
    if (!before) return;

    const opId = `op_${cryptoRandomId()}`;
    this.optimistic.set(opId, { opId, kind: "delete", id, before });
    this.deleteLocal(id);

    try {
      await this._delete(id);
      this.optimistic.delete(opId);
    } catch (e) {
      // rollback
      this.upsertLocal(before);
      this.optimistic.delete(opId);
      throw e;
    }
  }

  /* =========================
     INTERNAL: local store + signals
     ========================= */

  private getDocSignal(id: string): Signal<T | null> {
    let sig = this.docs.get(id);
    if (!sig) {
      sig = new Signal<T | null>(this.store.get(id) ?? null);
      this.docs.set(id, sig);
      // keep it in sync with store changes
      this.storeVersion.subscribe(() => sig!.value = this.store.get(id) ?? null);
    }
    return sig;
  }

  private bumpStore() {
    this.storeVersion.value = this.storeVersion.value + 1;
  }

  private upsertLocal(row: T) {
    const id = this.idOf(row);
    this.store.set(id, row);
    this.bumpStore();
  }

  private deleteLocal(id: string) {
    this.store.delete(id);
    this.bumpStore();
  }

  /* =========================
     INTERNAL: server event application
     ========================= */

  private applyServerEvent(ev: SubscriptionEvent<T>) {
    // If you don’t have per-subscription routing in the backend yet, do NOT use this.
    // This assumes events you receive are already scoped to this client + filter.
    switch (ev.type) {
      case "existing":
      case "added":
      case "changed": {
        const row = ev.object;
        const id = this.idOf(row);
        this.store.set(id, row);
        this.bumpStore();
        return;
      }
      case "removed": {
        this.store.delete(ev.objectId);
        this.bumpStore();
        return;
      }
      case "invalidate": {
        // minimal fallback: bump version so queries recompute;
        // real impl might trigger refetch for certain queries.
        this.bumpStore();
        return;
      }
    }
  }

  /* =========================
     Optional: cleanup
     ========================= */

  closeQuery(filter = "") {
    const entry = this.queries.get(filter);
    if (!entry) return;
    entry.sub?.close();
    this.queries.delete(filter);
  }
}

/** ---------- helper: id generator (no uuid dependency) ---------- */
function cryptoRandomId(): string {
  // browser or node >=19 has crypto; otherwise replace with uuidv4
  const c = (globalThis as any).crypto;
  if (c?.getRandomValues) {
    const buf = new Uint8Array(12);
    c.getRandomValues(buf);
    return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  // fallback
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
}

/* -----------------------------------------------------------
  Example transport: SSE (EventSource) for subscribe + fetch for CRUD
  (You can replace this with your own express endpoints.)
----------------------------------------------------------- */
export class FetchSseTransport<T> implements ResourceTransport<T> {
  constructor(private readonly baseUrl: string) {}

  async create(resource: string, data: unknown): Promise<T> {
    const r = await fetch(`${this.baseUrl}/${resource}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (!r.ok) throw new Error(await r.text());
    return (await r.json()) as T;
  }

  async update(resource: string, id: string, patch: unknown): Promise<T> {
    const r = await fetch(`${this.baseUrl}/${resource}/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!r.ok) throw new Error(await r.text());
    return (await r.json()) as T;
  }

  async replace(resource: string, id: string, data: unknown): Promise<T> {
    const r = await fetch(`${this.baseUrl}/${resource}/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (!r.ok) throw new Error(await r.text());
    return (await r.json()) as T;
  }

  async delete(resource: string, id: string): Promise<void> {
    const r = await fetch(`${this.baseUrl}/${resource}/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    if (!r.ok && r.status !== 204) throw new Error(await r.text());
  }

  async list(resource: string, filter = ""): Promise<T[]> {
    const url = new URL(`${this.baseUrl}/${resource}`);
    if (filter) url.searchParams.set("filter", filter);
    const r = await fetch(url.toString());
    if (!r.ok) throw new Error(await r.text());
    const j = await r.json();
    // assuming { items: [...] } like your code
    return (j.items ?? j) as T[];
  }

  subscribe(
    resource: string,
    filter: string,
    onEvent: (ev: SubscriptionEvent<T>) => void,
    onError?: (err: unknown) => void
  ): SubscriptionHandle {
    const url = new URL(`${this.baseUrl}/${resource}/subscribe`);
    if (filter) url.searchParams.set("filter", filter);

    const es = new EventSource(url.toString());
    es.addEventListener("message", (msg) => {
      try {
        const data = JSON.parse((msg as MessageEvent).data) as any;

        // Map your current events ("existing"/"new") into the richer set if needed
        if (data.type === "new") onEvent({ id: data.id, type: "added", object: data.object });
        else if (data.type === "existing") onEvent({ id: data.id, type: "existing", object: data.object });
        else onEvent(data as SubscriptionEvent<T>);
      } catch (e) {
        onError?.(e);
      }
    });

    es.addEventListener("error", (e) => onError?.(e));

    return { close: () => es.close() };
  }
}

/* -----------------------------------------------------------
  Usage example:

  type User = { id: string; name: string; age: number; role: string };

  const transport = new FetchSseTransport<User>("http://localhost:3000/api");
  const filterer = createResourceFilter(userTable); // must provide execute(expr, row) -> boolean
  const usersRepo = new ResourceRepository<User>("users", u => u.id, transport, filterer);

  // Reactive query
  const q = usersRepo.get(`age>=18;role=="admin"`);
  const unsub = q.subscribe(items => console.log("admins:", items));

  // Reactive single doc
  const doc = usersRepo.getById("u1");
  doc.subscribe(u => console.log("u1 changed:", u));

  // Optimistic mutation
  await usersRepo.updateOptimistic("u1", { name: "Derin" });
----------------------------------------------------------- */