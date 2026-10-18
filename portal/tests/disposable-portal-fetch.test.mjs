// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { disposablePortalFetch } from "./helpers/disposable-portal-fetch.mjs";

test("disposable portal requests close their sockets while preserving HTTP request and response semantics", async (t) => {
  const sockets = [];
  const closed = [];
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({ method: request.method, url: request.url, headers: request.headers, body });
    response.writeHead(201, { "content-type": "application/json", "x-fixture": "native-response" });
    response.end(JSON.stringify({ saved: body }));
  });
  server.on("connection", (socket) => {
    sockets.push(socket);
    closed.push(once(socket, "close"));
  });
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}/api/settings?scope=project`;
  const fetch = disposablePortalFetch();
  const headers = new Headers({ authorization: "Bearer fixture-token", "content-type": "application/json" });
  for (const input of [url, new Request(url, { method: "PUT", headers, body: '{"value":false}' })]) {
    const response = typeof input === "string"
      ? await fetch(input, { method: "PUT", headers, body: '{"value":false}' })
      : await fetch(input);
    assert.equal(response.status, 201);
    assert.equal(response.headers.get("x-fixture"), "native-response");
    assert.deepEqual(await response.json(), { saved: '{"value":false}' });
  }
  await Promise.all(closed);
  assert.equal(sockets.length, 2, "each request owns a new connection rather than borrowing a pooled socket");
  assert.ok(sockets.every((socket) => socket.destroyed));
  assert.equal(headers.has("connection"), false, "caller headers are not mutated");
  for (const request of requests) {
    assert.equal(request.method, "PUT");
    assert.equal(request.url, "/api/settings?scope=project");
    assert.equal(request.headers.connection, "close");
    assert.equal(request.headers.authorization, "Bearer fixture-token");
    assert.equal(request.headers["content-type"], "application/json");
    assert.equal(request.body, '{"value":false}');
  }
});

test("disposable portal fetch preserves options and propagates the original failure exactly once", async () => {
  const failure = new TypeError("fetch failed", { cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }) });
  const controller = new AbortController();
  const options = { method: "POST", body: "unchanged", signal: controller.signal, redirect: "error", cache: "no-store", headers: { authorization: "Bearer test" } };
  let attempts = 0;
  const fetch = disposablePortalFetch((input, actual) => {
    attempts += 1;
    assert.equal(input, "http://127.0.0.1:1/api/action");
    for (const key of ["method", "body", "signal", "redirect", "cache"]) assert.strictEqual(actual[key], options[key]);
    assert.equal(actual.headers.get("authorization"), "Bearer test");
    assert.equal(actual.headers.get("connection"), "close");
    return Promise.reject(failure);
  });
  await assert.rejects(fetch("http://127.0.0.1:1/api/action", options), (error) => error === failure);
  assert.equal(attempts, 1, "a socket failure is never retried or hidden");
});
