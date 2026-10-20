import { createHash, generateKeyPairSync, sign as nodeSign } from "node:crypto";

import { encodeBase64url } from "./encoding.js";
import type { WebDeviceKeyApis } from "./web.js";

type Listener = (() => void) | null;

class FakeRequest<T> {
  result!: T;
  error: DOMException | null = null;
  onsuccess: Listener = null;
  onerror: Listener = null;
  onupgradeneeded: Listener = null;
}

type Stores = Map<string, Map<string, unknown>>;

function fakeDatabase(stores: Stores) {
  const settle = <T>(request: FakeRequest<T>, work: () => T) => {
    queueMicrotask(() => {
      request.result = work();
      request.onsuccess?.();
    });
    return request as unknown as IDBRequest<T>;
  };
  return {
    createObjectStore: (name: string) => void stores.set(name, new Map()),
    transaction: (name: string) => ({
      objectStore: () => ({
        get: (key: string) => settle(new FakeRequest(), () => stores.get(name)?.get(key)),
        put: (value: unknown, key: string) =>
          settle(new FakeRequest(), () => void stores.get(name)?.set(key, value)),
      }),
    }),
  };
}

export interface FakeIndexedDB {
  readonly factory: IDBFactory;
  readonly databases: Map<string, Stores>;
}

export function fakeIndexedDB(databases: Map<string, Stores> = new Map()): FakeIndexedDB {
  const factory = {
    open: (name: string) => {
      const request = new FakeRequest<unknown>();
      queueMicrotask(() => {
        let stores = databases.get(name);
        const created = stores === undefined;
        if (!stores) databases.set(name, (stores = new Map()));
        request.result = fakeDatabase(stores);
        if (created) request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
  } as unknown as IDBFactory;
  return { factory, databases };
}

export interface FakeAuthenticator {
  readonly credentials: CredentialsContainer;
  readonly created: PublicKeyCredentialCreationOptions[];
  readonly requested: PublicKeyCredentialRequestOptions[];
  userVerified: boolean;
  cancel: boolean;
}

const asBuffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;

const bytesOf = (source: BufferSource): Uint8Array =>
  source instanceof ArrayBuffer
    ? new Uint8Array(source)
    : new Uint8Array(source.buffer, source.byteOffset, source.byteLength);

export function fakeAuthenticator(origin: string): FakeAuthenticator {
  const keys = new Map<string, ReturnType<typeof generateKeyPairSync<"ec">>>();
  const state: FakeAuthenticator = {
    created: [],
    requested: [],
    userVerified: true,
    cancel: false,
    credentials: {
      create: async (options?: CredentialCreationOptions) => {
        const publicKey = options!.publicKey!;
        state.created.push(publicKey);
        if (state.cancel) throw new DOMException("cancelled", "NotAllowedError");
        const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
        const id = new Uint8Array(16).map((_, at) => at + keys.size);
        keys.set(encodeBase64url(id), pair);
        return {
          type: "public-key",
          rawId: asBuffer(id),
          response: {
            attestationObject: asBuffer(new Uint8Array([0xa0])),
            getPublicKey: () =>
              asBuffer(pair.publicKey.export({ type: "spki", format: "der" })),
          },
        } as unknown as Credential;
      },
      get: async (options?: CredentialRequestOptions) => {
        const publicKey = options!.publicKey!;
        state.requested.push(publicKey);
        if (state.cancel || !state.userVerified) {
          throw new DOMException("no presence", "NotAllowedError");
        }
        const id = encodeBase64url(bytesOf(publicKey.allowCredentials![0]!.id));
        const pair = keys.get(id)!;
        const clientData = new TextEncoder().encode(
          JSON.stringify({
            type: "webauthn.get",
            challenge: encodeBase64url(bytesOf(publicKey.challenge)),
            origin,
          }),
        );
        const authData = new Uint8Array(37);
        authData.set(createHash("sha256").update(publicKey.rpId!).digest(), 0);
        authData[32] = 0x05;
        const signed = Buffer.concat([
          authData,
          createHash("sha256").update(clientData).digest(),
        ]);
        const signature = nodeSign("sha256", signed, {
          key: pair.privateKey,
          dsaEncoding: "der",
        });
        return {
          type: "public-key",
          rawId: asBuffer(bytesOf(publicKey.allowCredentials![0]!.id)),
          response: {
            authenticatorData: asBuffer(authData),
            clientDataJSON: asBuffer(clientData),
            signature: asBuffer(signature),
          },
        } as unknown as Credential;
      },
    } as CredentialsContainer,
  };
  return state;
}

export function fakeApis(input: {
  readonly indexedDB?: IDBFactory | undefined;
  readonly credentials?: CredentialsContainer | undefined;
}): () => WebDeviceKeyApis {
  return () => ({
    subtle: globalThis.crypto.subtle,
    indexedDB: input.indexedDB,
    credentials: input.credentials,
  });
}
