import type {
  IntegratedTerminalShellOption,
  IntranetProbeRequest,
  IntranetProbeResult,
  SystemInfo,
} from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import type { OfficialReleaseInfo } from "./officialReleaseInfo.js";
import { createServiceDescriptor } from "../descriptors.js";

export interface ISystemService {
  info(): Promise<SystemInfo>;
  getOfficialReleaseInfo?(locale?: "zh-CN" | "en-US"): Promise<OfficialReleaseInfo>;
  listIntegratedTerminalShells(): Promise<IntegratedTerminalShellOption[]>;
  probeIntranet(request: IntranetProbeRequest): Promise<IntranetProbeResult>;
}

export const ISystemService = createServiceDescriptor<ISystemService>(ServiceChannels.System);
