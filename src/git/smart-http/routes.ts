import type { factory } from "../../app/env";
import { badRequest, HttpError } from "../../errors";
import { buildAdvertisement } from "./advertise";
import { checkBasicAuth } from "./auth";
import { applyReceivePack, encodeReportStatus, parseReceiveCommands } from "./receivePack";
import { buildUploadPackResponse, parseUploadPackRequest } from "./uploadPack";
import { readUntilFlush } from "./pktline";

type App = ReturnType<typeof factory.createApp>;

export function registerSmartHttpRoutes(app: App): void {
  app.get("/:repo/info/refs", async (c) => {
    const service = c.req.query("service");
    if (service !== "git-upload-pack" && service !== "git-receive-pack") {
      throw badRequest(`Unsupported or missing service parameter: ${JSON.stringify(service)}`);
    }
    if (service === "git-receive-pack") {
      const rejection = await checkBasicAuth(c.req.header("Authorization"), c.env.pushCredentials);
      if (rejection) return rejection;
    }
    const repo = c.get("repo");
    const body = buildAdvertisement(repo, service);
    return new Response(body, {
      headers: {
        "Content-Type": `application/x-${service}-advertisement`,
        "Cache-Control": "no-cache",
      },
    });
  });

  app.post("/:repo/git-upload-pack", async (c) => {
    const repo = c.get("repo");
    const body = new Uint8Array(await c.req.arrayBuffer());
    const { wants, haves } = parseUploadPackRequest(body);
    const response = buildUploadPackResponse(repo, wants, haves);
    return new Response(response, {
      headers: { "Content-Type": "application/x-git-upload-pack-result" },
    });
  });

  app.post("/:repo/git-receive-pack", async (c) => {
    const repo = c.get("repo");
    const rejection = await checkBasicAuth(c.req.header("Authorization"), c.env.pushCredentials);
    if (rejection) return rejection;
    if (!repo.isBare()) throw new HttpError(403, "push is only allowed to bare repositories");

    const body = new Uint8Array(await c.req.arrayBuffer());
    const { lines, next } = readUntilFlush(body, 0);
    const { commands } = parseReceiveCommands(lines);
    const packBytes = body.subarray(next);
    const result = applyReceivePack(repo, commands, packBytes);
    return new Response(encodeReportStatus(result), {
      headers: { "Content-Type": "application/x-git-receive-pack-result" },
    });
  });
}
