import assert from "node:assert/strict";
import test from "node:test";
import {
  buildLoopbackContainerRequest,
  rebindContainerToLoopback,
} from "./docker-loopback.mjs";

function gatewayInspection() {
  return {
    Name: "/gateway",
    Config: { Image: "gateway:1" },
    HostConfig: {
      NetworkMode: "local-network",
      PortBindings: {
        "8000/tcp": [{ HostIp: "", HostPort: "7431" }],
      },
    },
    NetworkSettings: {
      Networks: {
        "local-network": {
          Aliases: ["gateway"],
          IPAMConfig: null,
        },
      },
    },
  };
}

test("container recreation preserves runtime config and binds every port to loopback", () => {
  const request = buildLoopbackContainerRequest({
    Name: "/gateway",
    Config: {
      Image: "gateway:1",
      Env: ["SECRET=kept-in-memory"],
      Labels: { project: "local" },
    },
    HostConfig: {
      NetworkMode: "local-network",
      Binds: ["volume:/data"],
      RestartPolicy: { Name: "unless-stopped" },
      PortBindings: {
        "8000/tcp": [
          { HostIp: "", HostPort: "7431" },
          { HostIp: "::", HostPort: "7431" },
        ],
      },
    },
    NetworkSettings: {
      Networks: {
        "local-network": {
          Aliases: ["gateway"],
          IPAMConfig: null,
        },
      },
    },
  });

  assert.deepEqual(request, {
    Image: "gateway:1",
    Env: ["SECRET=kept-in-memory"],
    Labels: { project: "local" },
    HostConfig: {
      NetworkMode: "local-network",
      Binds: ["volume:/data"],
      RestartPolicy: { Name: "unless-stopped" },
      PortBindings: {
        "8000/tcp": [
          { HostIp: "127.0.0.1", HostPort: "7431" },
        ],
      },
    },
    NetworkingConfig: {
      EndpointsConfig: {
        "local-network": {
          Aliases: ["gateway"],
          IPAMConfig: null,
        },
      },
    },
  });
});

test("container recreation fails closed without a network or published port", () => {
  assert.throws(
    () => buildLoopbackContainerRequest({
      Name: "/gateway",
      Config: {},
      HostConfig: { NetworkMode: "missing", PortBindings: {} },
      NetworkSettings: { Networks: {} },
    }),
    /not attached/u,
  );
  assert.throws(
    () => buildLoopbackContainerRequest({
      Name: "/gateway",
      Config: {},
      HostConfig: { NetworkMode: "local", PortBindings: {} },
      NetworkSettings: {
        Networks: { local: { Aliases: [], IPAMConfig: null } },
      },
    }),
    /no published ports/u,
  );
});

test("rebind restores the stopped original when rename fails", async () => {
  const calls = [];
  const request = async (_socketPath, method, path) => {
    calls.push(`${method} ${path}`);
    if (method === "GET") return gatewayInspection();
    if (path.includes("/rename?")) throw new Error("rename failed");
    return undefined;
  };

  await assert.rejects(
    rebindContainerToLoopback("/docker.sock", "gateway", request),
    /rename failed/u,
  );
  assert.deepEqual(calls, [
    "GET /containers/gateway/json",
    "POST /containers/gateway/stop?t=30",
    `POST /containers/gateway/rename?name=gateway-unbound-${process.pid}`,
    "POST /containers/gateway/start",
  ]);
});

test("rebind restores the renamed original when replacement creation fails", async () => {
  const calls = [];
  const request = async (_socketPath, method, path) => {
    calls.push(`${method} ${path}`);
    if (method === "GET") return gatewayInspection();
    if (path.startsWith("/containers/create?")) {
      throw new Error("create failed");
    }
    return undefined;
  };

  await assert.rejects(
    rebindContainerToLoopback("/docker.sock", "gateway", request),
    /create failed/u,
  );
  assert.deepEqual(calls, [
    "GET /containers/gateway/json",
    "POST /containers/gateway/stop?t=30",
    `POST /containers/gateway/rename?name=gateway-unbound-${process.pid}`,
    "POST /containers/create?name=gateway",
    `POST /containers/gateway-unbound-${process.pid}/rename?name=gateway`,
    "POST /containers/gateway/start",
  ]);
});
