import { api } from "./api.js";

export const CIRCLE_ENDPOINTS = {
  rename: (id, name) => api.renameCircle(id, name),
  addAlias: (id, alias) => api.addCircleAlias(id, alias),
  removeAlias: (id, alias) => api.removeCircleAlias(id, alias),
};
