import { decodePktLine, encodePktLine, concatBytes } from "./pktline";

export interface UploadPackRequest {
  wants: string[];
  haves: string[];
  capabilities: string[];
}

const decoder = new TextDecoder();

export function parseUploadPackRequest(data: Uint8Array): UploadPackRequest {
  const wants: string[] = [];
  const haves: string[] = [];
  const capabilities: string[] = [];
  let offset = 0;
  let sawWant = false;

  while (offset < data.length) {
    const { line, next } = decodePktLine(data, offset);
    offset = next;
    if (line.type === "flush") continue; // separates the want block from the have block

    const text = decoder.decode(line.payload).replace(/\n$/, "");
    if (text.startsWith("want ")) {
      // Extract the OID (40 chars after "want ")
      const oid = text.slice(5, 45);
      wants.push(oid);

      if (!sawWant) {
        // First want line may have capabilities after the OID
        const afterOid = text.slice(45).trim();
        if (afterOid) {
          capabilities.push(...afterOid.split(" ").filter(Boolean));
        }
        sawWant = true;
      }
    } else if (text.startsWith("have ")) {
      haves.push(text.slice(5, 45));
    } else if (text === "done") {
      break;
    }
  }

  return { wants, haves, capabilities };
}

export function buildUploadPackResponse(
  repo: { packObjects(wants: string[], haves: string[]): Uint8Array },
  wants: string[],
  haves: string[],
): Uint8Array {
  const packBytes = repo.packObjects(wants, haves);
  return concatBytes([encodePktLine("NAK\n"), packBytes]);
}
