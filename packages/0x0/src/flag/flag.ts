export namespace Flag {
  export const ZEROXZERO_FAKE_VCS = process.env["ZEROXZERO_FAKE_VCS"]
  export declare const ZEROXZERO_CLIENT: string
}

// Dynamic getter for ZEROXZERO_CLIENT
// This must be evaluated at access time, not module load time,
// because some commands override the client at runtime
Object.defineProperty(Flag, "ZEROXZERO_CLIENT", {
  get() {
    return process.env["ZEROXZERO_CLIENT"] ?? "cli"
  },
  enumerable: true,
  configurable: false,
})
