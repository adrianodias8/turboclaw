/**
 * Pure utility functions extracted from container manager for testability.
 */

/**
 * Remap a host HOME-relative path to the container HOME (/home/agent).
 * Non-matching paths pass through unchanged.
 */
export function remapHomePath(hostPath: string, hostHome: string, containerHome: string = "/home/agent"): string {
  if (hostPath.startsWith(hostHome)) {
    return containerHome + hostPath.slice(hostHome.length);
  }
  return hostPath;
}

/**
 * Rewrite localhost/127.0.0.1 URLs to host.docker.internal so containers
 * can reach host services.
 */
export function rewriteLocalhostUrls(text: string): string {
  return text
    .replace(/http:\/\/127\.0\.0\.1:/g, "http://host.docker.internal:")
    .replace(/http:\/\/localhost:/g, "http://host.docker.internal:");
}
