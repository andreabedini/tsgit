import type { factory } from "../../app/env";
import { badRequest, HttpError } from "../../errors";
import { buildAdvertisement, buildEmptyAdvertisement } from "./advertise";
import {
  buildFetchV2Response,
  buildLsRefsResponse,
  buildV2Advertisement,
  isV2Request,
  parseFetchV2Args,
  parseV2Request,
} from "./protocolV2";
import { applyReceivePack, encodeReportStatus, parseReceiveCommands } from "./receivePack";
import { buildUploadPackResponse, parseUploadPackRequest, DEEPEN_UNSUPPORTED } from "./uploadPack";
import { encodeErrLine, readUntilFlush } from "./pktline";

type App = ReturnType<typeof factory.createApp>;

export function registerSmartHttpRoutes(app: App): void {
  app.get("/:repo/info/refs", (c) => {
    const service = c.req.query("service");
    if (service !== "git-upload-pack" && service !== "git-receive-pack") {
      throw badRequest(`Unsupported or missing service parameter: ${JSON.stringify(service)}`);
    }
    // v2 is fetch-only — push (git-receive-pack) always gets the v0/v1
    // advertisement, matching real git servers.
    const wantsV2 =
      service === "git-upload-pack" && (c.req.header("Git-Protocol") ?? "").includes("version=2");
    // A push aimed at a repo that doesn't exist yet: useRepository has
    // authenticated it and deliberately created nothing, so answer with the
    // advertisement an empty repo would give and let the POST do the creating.
    const body = c.get("pushCreatePending")
      ? buildEmptyAdvertisement(service)
      : wantsV2
        ? buildV2Advertisement()
        : buildAdvertisement(c.get("repo"), service);
    return new Response(body as BodyInit, {
      headers: {
        "Content-Type": `application/x-${service}-advertisement`,
        "Cache-Control": "no-cache",
      },
    });
  });

  app.post("/:repo/git-upload-pack", async (c) => {
    const repo = c.get("repo");
    const body = new Uint8Array(await c.req.arrayBuffer());

    if (isV2Request(body)) {
      const { command, args } = parseV2Request(body);
      const responseHeaders = { "Content-Type": "application/x-git-upload-pack-result" };
      if (command === "ls-refs") {
        return new Response(buildLsRefsResponse(repo, args) as BodyInit, { headers: responseHeaders });
      }
      if (command === "fetch") {
        const fetchArgs = parseFetchV2Args(args);
        if (fetchArgs.deepen) {
          return new Response(encodeErrLine(DEEPEN_UNSUPPORTED) as BodyInit, { headers: responseHeaders });
        }
        return new Response(buildFetchV2Response(repo, fetchArgs) as BodyInit, { headers: responseHeaders });
      }
      throw badRequest(`Unsupported protocol v2 command: ${JSON.stringify(command)}`);
    }

    const { wants, haves, deepen } = parseUploadPackRequest(body);
    // We can report our own shallow boundary, but not compute a new one for a
    // client that wants a shallow clone. Say so rather than sending a full pack
    // the client will misread (it would be waiting for a shallow-update).
    const response = deepen
      ? encodeErrLine(DEEPEN_UNSUPPORTED)
      : buildUploadPackResponse(repo, wants, haves);
    return new Response(response as BodyInit, {
      headers: { "Content-Type": "application/x-git-upload-pack-result" },
    });
  });

  app.post("/:repo/git-receive-pack", async (c) => {
    const repo = c.get("repo");
    // Authentication (and, for a repo that doesn't exist yet, creation) already
    // happened in useRepository.
    if (!repo.isBare()) throw new HttpError(403, "push is only allowed to bare repositories");

    const body = new Uint8Array(await c.req.arrayBuffer());
    const { lines, next } = readUntilFlush(body, 0);
    const { commands } = parseReceiveCommands(lines);
    const packBytes = body.subarray(next);
    const result = await applyReceivePack(repo, commands, packBytes);
    return new Response(encodeReportStatus(result) as BodyInit, {
      headers: { "Content-Type": "application/x-git-receive-pack-result" },
    });
  });
}
