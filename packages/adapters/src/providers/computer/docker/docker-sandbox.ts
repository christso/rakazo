import { SupervisorSandboxProvider } from "../../../computers/sandbox/supervisor/supervisor-sandbox.js";

export {
  HEALTH_CHECK_TIMEOUT_MS,
  MAX_SANDBOX_ERROR_RESPONSE_BYTES,
  MAX_SANDBOX_SUCCESS_RESPONSE_BYTES,
  SCREEN_RELEASE_TIMEOUT_MS,
} from "../../../computers/sandbox/supervisor/supervisor-sandbox.js";

export class DockerSandboxProvider extends SupervisorSandboxProvider {
  constructor(supervisorUrl: string, supervisorToken?: string) {
    super(supervisorUrl, supervisorToken, "docker");
  }
}
