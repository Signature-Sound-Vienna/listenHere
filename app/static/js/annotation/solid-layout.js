// Where an annotation's resources live in the pod.
//
// Each resource stays in the container for its type, and sits in a folder of
// its own annotation inside it:
//
//   at.ac.mdw.mei-friend/oa/<ann>/<slug>
//   at.ac.mdw.mei-friend/mao/musicalMaterial/<ann>/<slug>
//   at.ac.mdw.mei-friend/mao/extract/<ann>/<slug>
//   at.ac.mdw.mei-friend/mao/selection/<ann>/<slug>
//
// so that access to the whole annotation is set once per type, on the folders
// (see solid-access.js), however many resources it has. Annotations posted
// before this layout have flat URIs (<type container>/<slug>); they match
// nothing here and are treated as legacy.
//
// Nothing reads meaning from these paths: a resource's type is its @type. The
// path only tells the access and delete code which folder to act on.

import {
  annotationContainer,
  extractContainer,
  musicalMaterialContainer,
  selectionContainer,
} from "../solid.js";

const _escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const _TYPE_CONTAINERS = [
  annotationContainer,
  musicalMaterialContainer,
  extractContainer,
  selectionContainer,
];

// 1: up to and including the type container, 2: the folder's name, 3: the slug.
const _RESOURCE_IN_FOLDER = new RegExp(
  "^(.*/(?:" + _TYPE_CONTAINERS.map(_escape).join("|") + "))([^/]+)/([^/]+)$",
);

/**
 * Split a resource URI of the per-annotation layout into its folder URI (with
 * trailing slash), the folder's name, and the resource's slug. Null for a flat
 * (legacy) URI or anything else.
 */
export function parseAnnotationResourceUri(uri) {
  const m = typeof uri === "string" && _RESOURCE_IN_FOLDER.exec(uri);
  if (!m) return null;
  return { folder: m[1] + m[2] + "/", folderId: m[2], slug: m[3] };
}

/** The distinct annotation folders that hold the given resource URIs. */
export function annotationFoldersOf(uris) {
  const folders = new Set();
  for (const uri of uris) {
    const p = parseAnnotationResourceUri(uri);
    if (p) folders.add(p.folder);
  }
  return [...folders];
}

/** The folder name the given annotation's resources share, or null if it is flat. */
export function folderIdOf(uris) {
  for (const uri of uris) {
    const p = parseAnnotationResourceUri(uri);
    if (p) return p.folderId;
  }
  return null;
}
