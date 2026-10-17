// SPDX-License-Identifier: Apache-2.0

// DOM fixtures start and stop many independent servers on OS-assigned loopback ports.
// A process-global fetch pool outlives those servers and can retain a socket for a
// port subsequently assigned to another fixture. These requests own their connection:
// native fetch still performs the real HTTP exchange, but no idle socket crosses a
// fixture boundary. Do not retry here: even a single failed request must fail its test.
export function disposablePortalFetch(nativeFetch = globalThis.fetch) {
  return (input, options = {}) => {
    const headers = new Headers(options.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.set("connection", "close");
    return nativeFetch(input, { ...options, headers });
  };
}
