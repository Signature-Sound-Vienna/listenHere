// Making an annotation public or private, with Web Access Control (WAC).
//
// WAC keeps the rules for a resource in an auxiliary ".acl" document, found
// from the resource's `Link: <…>; rel="acl"` header. A folder's ACL can carry
// `acl:default`, which its members inherit: an annotation's resources live in
// one folder per type (solid-layout.js), so one ACL per folder, four at most,
// covers every resource of the annotation, including ones a later update adds.
//
// The other mechanism, Access Control Policies (ACP), is recognised and
// refused with a clear message rather than guessed at.
//
// The ACLs this writes REPLACE whatever rules the folder had: the owner keeps
// full control, and the public rule is added or left out. The folders are
// created by Listen Here for one annotation; sharing with named people is not
// done here.
//
// WAC vocabulary: https://solid.github.io/web-access-control-spec/

import { solid } from "../solid.js";
import { annotationFoldersOf, parseAnnotationResourceUri } from "./solid-layout.js";

/** Parse a Link header into [{ url, rel }], resolving each target against `base`. */
export function parseLinkHeader(header, base) {
  const out = [];
  if (!header) return out;
  for (const part of header.split(/,\s*(?=<)/)) {
    const m = /^\s*<([^>]*)>([\s\S]*)$/.exec(part);
    if (!m) continue;
    const rels = /;\s*rel\s*=\s*"?([^";]+)"?/i.exec(m[2]);
    if (!rels) continue;
    let url;
    try {
      url = new URL(m[1], base).href;
    } catch (_) {
      continue;
    }
    for (const rel of rels[1].trim().split(/\s+/)) out.push({ url, rel });
  }
  return out;
}

/** Parse `WAC-Allow: user="read write",public="read"` into sets of mode names. */
export function parseWacAllow(header) {
  const out = { user: new Set(), public: new Set() };
  if (!header) return out;
  for (const m of header.matchAll(/\b(user|public)\s*=\s*"([^"]*)"/gi)) {
    for (const mode of m[2].split(/\s+/).filter(Boolean)) {
      out[m[1].toLowerCase()].add(mode.toLowerCase());
    }
  }
  return out;
}

/**
 * HEAD a resource and read how its access is controlled: the ACL's address
 * (`aclUri`), the WAC-Allow modes, and whether it is ACP-controlled.
 */
export async function discoverAccessControl(uri) {
  // Never from the browser's HTTP cache: a change to an ACL does not change the
  // resource's own validators, so a HEAD can be answered from a heuristically
  // fresh copy whose WAC-Allow is the old one (seen in Firefox: a change that
  // had worked was read back as unchanged and reported as failed).
  const resp = await solid.fetch(uri, { method: "HEAD", cache: "no-store" });
  if (!resp.ok) {
    throw new Error(
      "Couldn't read access information for " + uri + " (" + resp.status + ").",
    );
  }
  const links = parseLinkHeader(resp.headers.get("Link"), resp.url || uri);
  const wacAllowHeader = resp.headers.get("WAC-Allow");
  return {
    aclUri: (links.find((l) => l.rel === "acl") || {}).url || null,
    acp: links.some((l) => /solid\/acp#/.test(l.rel)),
    hasWacAllow: wacAllowHeader !== null,
    wacAllow: parseWacAllow(wacAllowHeader),
  };
}

/** The ACL document for a folder: the owner has everything; optionally anyone may read. */
export function buildFolderAcl({ webId, folderUri, isPublic }) {
  const lines = [
    "@prefix acl: <http://www.w3.org/ns/auth/acl#>.",
    "@prefix foaf: <http://xmlns.com/foaf/0.1/>.",
    "",
    "<#owner> a acl:Authorization;",
    "  acl:agent <" + webId + ">;",
    "  acl:accessTo <" + folderUri + ">;",
    "  acl:default <" + folderUri + ">;",
    "  acl:mode acl:Read, acl:Write, acl:Control.",
  ];
  if (isPublic) {
    // `default` only: the resources in the folder become readable, while
    // listing the folder itself stays the owner's.
    lines.push(
      "",
      "<#public> a acl:Authorization;",
      "  acl:agentClass foaf:Agent;",
      "  acl:default <" + folderUri + ">;",
      "  acl:mode acl:Read.",
    );
  }
  return lines.join("\n") + "\n";
}

const _UNSUPPORTED_ACP =
  "This pod controls access with Access Control Policies (ACP), which Listen Here can't set yet.";
const _UNSUPPORTED_OTHER =
  "Couldn't find how this pod controls access (no Web Access Control information).";

function _checkSupported(info) {
  if (info.acp) throw new Error(_UNSUPPORTED_ACP);
  if (!info.aclUri) throw new Error(_UNSUPPORTED_OTHER);
}

/** Set one folder's ACL (HEAD to find it, then PUT). */
export async function setFolderAccess(folderUri, isPublic, webId) {
  const info = await discoverAccessControl(folderUri);
  _checkSupported(info);
  const resp = await solid.fetch(info.aclUri, {
    method: "PUT",
    headers: { "Content-Type": "text/turtle" },
    body: buildFolderAcl({ webId, folderUri, isPublic }),
  });
  if (!resp.ok) {
    throw new Error(
      "Couldn't set access on " + folderUri + " (" + resp.status + ").",
    );
  }
}

/**
 * Whether an annotation is public, read from the MusicalMaterial's WAC-Allow
 * header (one request). `state`: "public", "private", "legacy" (posted in the
 * flat layout, so not settable), "unsupported" (ACP, or no access information).
 */
export async function getAnnotationAccess(lastPostedUris) {
  const mm = lastPostedUris && lastPostedUris.mm;
  if (!mm) return { state: "unsupported", reason: "Not posted yet." };
  if (!parseAnnotationResourceUri(mm)) {
    return {
      state: "legacy",
      reason:
        "Posted in the older flat layout; delete it from the pod and post it again to make it public.",
    };
  }
  const info = await discoverAccessControl(mm);
  if (info.acp) return { state: "unsupported", reason: _UNSUPPORTED_ACP };
  if (!info.hasWacAllow) return { state: "unsupported", reason: _UNSUPPORTED_OTHER };
  return { state: info.wacAllow.public.has("read") ? "public" : "private" };
}

/**
 * Make an annotation public or private by setting the ACL of each of its
 * folders (a HEAD and a PUT apiece), then reading the result back. The
 * MusicalMaterial's folder goes last when making public and first when making
 * private, so the annotation never looks public with parts of it still closed.
 * `onProgress(done, total)` counts the folders and the read-back.
 */
export async function setAnnotationAccess(lastPostedUris, isPublic, opts = {}) {
  const onProgress = opts.onProgress || (() => {});
  const uris = Object.values(lastPostedUris || {}).filter(Boolean);
  const folders = annotationFoldersOf(uris);
  if (folders.length === 0) {
    throw new Error(
      "This annotation was posted in the older flat layout; delete it from the pod and post it again to make it public.",
    );
  }
  const session = solid.getDefaultSession();
  const webId = session && session.info && session.info.webId;
  if (!webId || !session.info.isLoggedIn) {
    throw new Error("Sign in to your Solid pod first.");
  }
  const mmFolder = (parseAnnotationResourceUri(lastPostedUris.mm) || {}).folder;
  const ordered = [...folders].sort((a, b) =>
    (a === mmFolder ? 1 : 0) - (b === mmFolder ? 1 : 0),
  );
  if (!isPublic) ordered.reverse();

  const total = ordered.length + 1;
  let done = 0;
  onProgress(done, total);
  for (const folder of ordered) {
    await setFolderAccess(folder, isPublic, webId);
    onProgress(++done, total);
  }
  const after = await getAnnotationAccess(lastPostedUris);
  onProgress(++done, total);
  if (after.state !== (isPublic ? "public" : "private")) {
    throw new Error(
      "The pod did not report the annotation as " +
        (isPublic ? "public" : "private") +
        " after the change.",
    );
  }
  return after;
}

/**
 * After an annotation's resources were deleted: remove each annotation folder
 * all of whose resources are gone (the folder's ACL goes with it). Best
 * effort; a folder that still has something in it simply stays.
 */
export async function removeEmptiedAnnotationFolders(deletedUris) {
  const removed = [];
  for (const folder of annotationFoldersOf(deletedUris)) {
    try {
      const resp = await solid.fetch(folder, { method: "DELETE" });
      if (resp.ok || resp.status === 404) removed.push(folder);
      else console.warn("[annotation/v6] couldn't remove folder", folder, resp.status);
    } catch (err) {
      console.warn("[annotation/v6] removing folder threw for", folder, err);
    }
  }
  return removed;
}
