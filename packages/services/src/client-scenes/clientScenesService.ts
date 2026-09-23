import type { ApiClient } from "@zcode/shared";
import { readApiJson } from "../providers/api/apiJson.js";
import { ZCODE_CLIENT_SCENES_URL } from "../providers/api/apiEndpoints.js";
import type { ClientScenesResponse, IClientScenesService } from "./clientScenes.js";

export function createClientScenesService(dependencies: {
  apiClient: ApiClient;
}): IClientScenesService {
  return {
    list: () =>
      process.env.ANYAGENT_M0 === "1"
        ? Promise.resolve({ code: 0, msg: "", data: [] })
        : readApiJson<ClientScenesResponse>(dependencies.apiClient, ZCODE_CLIENT_SCENES_URL, {
            method: "GET",
          }),
  };
}
