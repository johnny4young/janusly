export function assertCleanInstallRequest(argumentsList) {
  if (!argumentsList.includes("--auth")) {
    throw new Error("clean installation requires the real local identity profile (--auth)");
  }
  if (!argumentsList.includes("--confirm-reset")) {
    throw new Error(
      "clean installation removes all local Auth and Janusly data; repeat with --confirm-reset",
    );
  }
}
