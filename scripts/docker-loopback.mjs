/** Recreates a running Docker container with explicit loopback port bindings. */

import { spawn } from "node:child_process";
import http from "node:http";

function runDocker(argumentsList) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("docker", argumentsList, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => code === 0
      ? resolvePromise(stdout)
      : reject(new Error(
        `docker ${argumentsList.join(" ")} exited ${code}${stderr ? `: ${stderr.trim()}` : ""}`,
      )));
  });
}

async function resolveDockerSocket() {
  const endpoint = (await runDocker([
    "context",
    "inspect",
    "--format",
    "{{.Endpoints.docker.Host}}",
  ])).trim();
  if (!endpoint.startsWith("unix://")) {
    throw new Error(
      `Local loopback hardening requires a Unix Docker endpoint, received ${endpoint}`,
    );
  }
  return endpoint.slice("unix://".length);
}

function requestDocker(socketPath, method, path, body, expectedStatuses) {
  return new Promise((resolvePromise, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const request = http.request({
      socketPath,
      method,
      path,
      headers: payload === undefined
        ? undefined
        : {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(payload),
          },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if (!expectedStatuses.includes(response.statusCode)) {
          reject(new Error(
            `Docker API ${method} ${path} returned ${response.statusCode}: ${text}`,
          ));
          return;
        }
        resolvePromise(text ? JSON.parse(text) : undefined);
      });
    });
    request.on("error", reject);
    if (payload !== undefined) request.write(payload);
    request.end();
  });
}

export function buildLoopbackContainerRequest(inspection) {
  const networkMode = inspection.HostConfig?.NetworkMode;
  const endpoint = inspection.NetworkSettings?.Networks?.[networkMode];
  if (!networkMode || !endpoint) {
    throw new Error(
      `Container ${inspection.Name} is not attached to its configured network`,
    );
  }

  const portBindings = {};
  for (const [port, bindings] of Object.entries(
    inspection.HostConfig.PortBindings ?? {},
  )) {
    const hostPorts = new Set(
      (bindings ?? []).map((binding) => binding.HostPort),
    );
    portBindings[port] = [...hostPorts].map((hostPort) => ({
      HostIp: "127.0.0.1",
      HostPort: hostPort,
    }));
  }
  if (Object.keys(portBindings).length === 0) {
    throw new Error(`Container ${inspection.Name} has no published ports`);
  }

  return {
    ...inspection.Config,
    HostConfig: {
      ...inspection.HostConfig,
      PortBindings: portBindings,
    },
    NetworkingConfig: {
      EndpointsConfig: {
        [networkMode]: {
          Aliases: endpoint.Aliases,
          IPAMConfig: endpoint.IPAMConfig,
        },
      },
    },
  };
}

async function waitUntilReady(
  socketPath,
  containerName,
  requestDockerImpl,
  timeoutMs = 60_000,
) {
  const deadline = Date.now() + timeoutMs;
  let lastState;
  while (Date.now() < deadline) {
    const inspection = await requestDockerImpl(
      socketPath,
      "GET",
      `/containers/${encodeURIComponent(containerName)}/json`,
      undefined,
      [200],
    );
    lastState = inspection.State;
    if (lastState.Health?.Status === "unhealthy") {
      throw new Error(`Container ${containerName} became unhealthy`);
    }
    if (
      lastState.Running
      && (!lastState.Health || lastState.Health.Status === "healthy")
    ) {
      return;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new Error(
    `Container ${containerName} did not become ready: ${JSON.stringify(lastState)}`,
  );
}

export async function rebindContainerToLoopback(
  socketPath,
  containerName,
  requestDockerImpl = requestDocker,
) {
  const encodedName = encodeURIComponent(containerName);
  const inspection = await requestDockerImpl(
    socketPath,
    "GET",
    `/containers/${encodedName}/json`,
    undefined,
    [200],
  );
  const createRequest = buildLoopbackContainerRequest(inspection);
  const backupName = `${containerName}-unbound-${process.pid}`;
  let originalStopped = false;
  let renamed = false;
  let replacementId;
  let replacementReady = false;

  try {
    await requestDockerImpl(
      socketPath,
      "POST",
      `/containers/${encodedName}/stop?t=30`,
      undefined,
      [204, 304],
    );
    originalStopped = true;
    await requestDockerImpl(
      socketPath,
      "POST",
      `/containers/${encodedName}/rename?name=${encodeURIComponent(backupName)}`,
      undefined,
      [204],
    );
    renamed = true;

    const created = await requestDockerImpl(
      socketPath,
      "POST",
      `/containers/create?name=${encodedName}`,
      createRequest,
      [201],
    );
    replacementId = created.Id;
    await requestDockerImpl(
      socketPath,
      "POST",
      `/containers/${replacementId}/start`,
      undefined,
      [204, 304],
    );
    await waitUntilReady(
      socketPath,
      containerName,
      requestDockerImpl,
    );
    replacementReady = true;
    await requestDockerImpl(
      socketPath,
      "DELETE",
      `/containers/${encodeURIComponent(backupName)}?v=false`,
      undefined,
      [204],
    );
  } catch (error) {
    if (replacementReady) {
      throw error;
    }
    const rollbackErrors = [];
    const attemptRollback = async (operation) => {
      try {
        await operation();
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    };
    if (replacementId) {
      await attemptRollback(() => requestDockerImpl(
        socketPath,
        "DELETE",
        `/containers/${replacementId}?force=true&v=false`,
        undefined,
        [204, 404],
      ));
    }
    if (renamed) {
      await attemptRollback(() => requestDockerImpl(
        socketPath,
        "POST",
        `/containers/${encodeURIComponent(backupName)}/rename?name=${encodedName}`,
        undefined,
        [204],
      ));
    }
    if (originalStopped) {
      await attemptRollback(() => requestDockerImpl(
        socketPath,
        "POST",
        `/containers/${encodedName}/start`,
        undefined,
        [204, 304],
      ));
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        `Failed to rebind and restore Docker container ${containerName}`,
      );
    }
    throw error;
  }
}

export async function rebindPublishedContainerToLoopback(containerName) {
  await rebindContainerToLoopback(
    await resolveDockerSocket(),
    containerName,
  );
}
