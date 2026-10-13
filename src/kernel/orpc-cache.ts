/** The tag cache behind the resources, injectable after `provideORPC()` */
// not @Injectable: the package ships prebuilt, without jit
export abstract class ORPCCache {
  /** Drops entries under these tags and reloads the resources that read them */
  abstract invalidate(...tags: string[]): void;
  /** Drops everything without reloading, e.g. on sign-out */
  abstract clear(): void;
  /** Drops everything and reloads every tagged resource */
  abstract invalidateAll(): void;
}
