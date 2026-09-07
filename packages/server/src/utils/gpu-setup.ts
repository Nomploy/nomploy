import { execAsync, execAsyncRemote, sleep } from "../utils/process/execAsync";

// The nomad-device-nvidia plugin version installed into Nomad's plugin dir.
// Pinned so the download is reproducible; bump deliberately.
const NOMAD_DEVICE_NVIDIA_VERSION = "1.1.0";
// Nomad's default plugin_dir is <data_dir>/plugins; data_dir is /opt/nomad
// (install.sh + nomad-cluster.ts). The device plugin binary lives here.
const NOMAD_PLUGIN_DIR = "/opt/nomad/plugins";
const NVIDIA_PLUGIN_HCL = "/etc/nomad.d/nvidia.hcl";

/**
 * GPU status for a node in the Nomad model.
 * - driver/toolkit/runtime describe the host + Docker prerequisites.
 * - nomadPluginInstalled/nomadGpuCount describe whether Nomad's
 *   nomad-device-nvidia plugin is present and how many GPUs Nomad has
 *   fingerprinted (i.e. how many are schedulable via `device "nvidia/gpu"`).
 */
interface GPUInfo {
	driverInstalled: boolean;
	driverVersion?: string;
	gpuModel?: string;
	memoryInfo?: string;
	availableGPUs: number;
	cudaSupport: boolean;
	cudaVersion?: string;
	/** nvidia-container-toolkit (nvidia-ctk) present. */
	toolkitInstalled: boolean;
	/** Docker knows the "nvidia" runtime (nvidia-ctk runtime configure). */
	dockerRuntimeConfigured: boolean;
	/** The nomad-device-nvidia plugin binary is installed. */
	nomadPluginInstalled: boolean;
	/** GPUs Nomad has fingerprinted on this node (schedulable). */
	nomadGpuCount: number;
}

const emptyStatus: GPUInfo = {
	driverInstalled: false,
	driverVersion: undefined,
	gpuModel: undefined,
	memoryInfo: undefined,
	availableGPUs: 0,
	cudaSupport: false,
	cudaVersion: undefined,
	toolkitInstalled: false,
	dockerRuntimeConfigured: false,
	nomadPluginInstalled: false,
	nomadGpuCount: 0,
};

export async function checkGPUStatus(serverId?: string): Promise<GPUInfo> {
	try {
		const [driverInfo, toolkitInfo, nomadInfo, gpuInfo, cudaInfo] =
			await Promise.all([
				checkGpuDriver(serverId),
				checkToolkit(serverId),
				checkNomadGpu(serverId),
				checkGpuInfo(serverId),
				checkCudaSupport(serverId),
			]);

		return {
			...emptyStatus,
			...driverInfo,
			...toolkitInfo,
			...nomadInfo,
			...gpuInfo,
			...cudaInfo,
		};
	} catch {
		return { ...emptyStatus };
	}
}

const run = async (cmd: string, serverId?: string) =>
	serverId ? execAsyncRemote(serverId, cmd) : execAsync(cmd);

const checkGpuDriver = async (serverId?: string) => {
	let driverVersion: string | undefined;
	let driverInstalled = false;
	let availableGPUs = 0;

	try {
		const { stdout: nvidiaSmi } = await run(
			"nvidia-smi --query-gpu=driver_version --format=csv,noheader",
			serverId,
		);
		driverVersion = nvidiaSmi.trim().split("\n")[0]?.trim();
		if (driverVersion) {
			driverInstalled = true;
			const { stdout: gpuCount } = await run(
				"nvidia-smi --query-gpu=gpu_name --format=csv,noheader | wc -l",
				serverId,
			);
			availableGPUs = Number.parseInt(gpuCount.trim(), 10) || 0;
		}
	} catch (error) {
		console.debug("GPU driver check:", error);
	}

	return { driverVersion, driverInstalled, availableGPUs };
};

const checkToolkit = async (serverId?: string) => {
	let toolkitInstalled = false;
	let dockerRuntimeConfigured = false;

	try {
		const { stdout } = await run(
			"command -v nvidia-ctk || command -v nvidia-container-toolkit || true",
			serverId,
		);
		toolkitInstalled = !!stdout.trim();
	} catch (error) {
		console.debug("Toolkit binary check:", error);
	}

	try {
		const { stdout: runtimeInfo } = await run(
			'docker info --format "{{json .Runtimes}}"',
			serverId,
		);
		const runtimes = JSON.parse(runtimeInfo);
		dockerRuntimeConfigured = "nvidia" in runtimes;
	} catch (error) {
		console.debug("Docker runtime check:", error);
	}

	return { toolkitInstalled, dockerRuntimeConfigured };
};

/**
 * Is the nomad-device-nvidia plugin installed, and how many GPUs has Nomad
 * fingerprinted on this node? Reads the local agent's own node devices.
 */
const checkNomadGpu = async (serverId?: string) => {
	let nomadPluginInstalled = false;
	let nomadGpuCount = 0;

	try {
		const { stdout } = await run(
			`test -x ${NOMAD_PLUGIN_DIR}/nomad-device-nvidia && echo yes || true`,
			serverId,
		);
		nomadPluginInstalled = stdout.trim() === "yes";
	} catch (error) {
		console.debug("Nomad plugin check:", error);
	}

	try {
		// `-self` targets the agent running on this host. Devices of type "gpu"
		// (vendor nvidia) each carry a list of instances = individual GPUs.
		const { stdout } = await run(
			"nomad node status -self -json 2>/dev/null || true",
			serverId,
		);
		if (stdout.trim()) {
			const node = JSON.parse(stdout);
			const devices = node?.NodeResources?.Devices ?? [];
			for (const d of devices) {
				if (String(d?.Type).toLowerCase() === "gpu") {
					nomadGpuCount += Array.isArray(d?.Instances) ? d.Instances.length : 0;
				}
			}
		}
	} catch (error) {
		console.debug("Nomad GPU fingerprint check:", error);
	}

	return { nomadPluginInstalled, nomadGpuCount };
};

const checkGpuInfo = async (serverId?: string) => {
	let gpuModel: string | undefined;
	let memoryInfo: string | undefined;

	try {
		const { stdout: gpuInfo } = await run(
			"nvidia-smi --query-gpu=gpu_name,memory.total --format=csv,noheader",
			serverId,
		);
		const firstLine = gpuInfo.trim().split("\n")[0] ?? "";
		[gpuModel, memoryInfo] = firstLine.split(",").map((s) => s.trim());
	} catch (error) {
		console.debug("GPU info check:", error);
	}

	return { gpuModel, memoryInfo };
};

const checkCudaSupport = async (serverId?: string) => {
	let cudaVersion: string | undefined;
	let cudaSupport = false;

	try {
		const { stdout: cudaInfo } = await run(
			'nvidia-smi -q | grep "CUDA Version"',
			serverId,
		);
		const cudaMatch = cudaInfo.match(/CUDA Version\s*:\s*([\d.]+)/);
		cudaVersion = cudaMatch ? cudaMatch[1] : undefined;
		cudaSupport = !!cudaVersion;
	} catch (error) {
		console.debug("CUDA support check:", error);
	}

	return { cudaVersion, cudaSupport };
};

/**
 * Enable GPU scheduling on a Nomad node: install the NVIDIA Container Toolkit,
 * point Docker at the nvidia runtime, install the nomad-device-nvidia plugin
 * into Nomad's plugin dir, drop its config, and restart Docker + Nomad so the
 * node fingerprints its GPUs as `nvidia/gpu` devices. Requires the NVIDIA driver
 * (nvidia-smi) to already be installed — driver installation is hardware- and
 * distro-specific and left to the operator.
 */
export async function setupGPUSupport(serverId?: string): Promise<void> {
	const status = await checkGPUStatus(serverId);
	if (!status.driverInstalled) {
		throw new Error(
			"NVIDIA driver not found (nvidia-smi failed). Install the NVIDIA driver for your GPU + distro first, then enable GPU support.",
		);
	}

	const script = buildGpuSetupScript();
	try {
		await run(script, serverId);
	} catch (error) {
		if (
			error instanceof Error &&
			/password is required|sudo/i.test(error.message)
		) {
			throw new Error(
				"Passwordless sudo is required to configure GPU support on this node.",
			);
		}
		throw error;
	}

	// Give Nomad a moment to restart + re-fingerprint devices, then verify.
	await sleep(8000);
	const final = await checkGPUStatus(serverId);
	if (!final.nomadPluginInstalled) {
		throw new Error(
			"nomad-device-nvidia plugin did not install. Check the node's /opt/nomad/plugins and Nomad logs.",
		);
	}
	if (final.nomadGpuCount === 0) {
		throw new Error(
			"GPU toolkit + plugin installed, but Nomad has not fingerprinted a GPU yet. Verify `nvidia-smi` works and check `nomad node status -self` after a moment.",
		);
	}
}

/**
 * Idempotent host-setup script: NVIDIA Container Toolkit (apt or dnf) → Docker
 * nvidia runtime → nomad-device-nvidia plugin + config → restart Docker+Nomad.
 */
const buildGpuSetupScript = (): string => `
set -e
SUDO=""
if [ "$EUID" -ne 0 ]; then
  if sudo -n true 2>/dev/null; then SUDO="sudo"; else
    echo "Error: passwordless sudo required"; exit 1; fi
fi

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64) PLUGIN_ARCH=amd64 ;;
  aarch64|arm64) PLUGIN_ARCH=arm64 ;;
  *) echo "Unsupported arch: $ARCH"; exit 1 ;;
esac

# 1. NVIDIA Container Toolkit (skip if nvidia-ctk already present).
if ! command -v nvidia-ctk >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
      | $SUDO gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
    curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
      | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
      | $SUDO tee /etc/apt/sources.list.d/nvidia-container-toolkit.list >/dev/null
    $SUDO apt-get update
    $SUDO apt-get install -y nvidia-container-toolkit
  elif command -v dnf >/dev/null 2>&1; then
    curl -fsSL https://nvidia.github.io/libnvidia-container/stable/rpm/nvidia-container-toolkit.repo \
      | $SUDO tee /etc/yum.repos.d/nvidia-container-toolkit.repo >/dev/null
    $SUDO dnf install -y nvidia-container-toolkit
  else
    echo "Error: need apt-get or dnf to install nvidia-container-toolkit"; exit 1
  fi
fi

# 2. Register the nvidia runtime with Docker (not as default) + restart Docker.
$SUDO nvidia-ctk runtime configure --runtime=docker
$SUDO systemctl restart docker

# 3. Install the nomad-device-nvidia plugin into Nomad's plugin dir.
$SUDO mkdir -p ${NOMAD_PLUGIN_DIR}
TMP="$(mktemp -d)"
curl -fsSL -o "$TMP/plugin.zip" \
  "https://releases.hashicorp.com/nomad-device-nvidia/${NOMAD_DEVICE_NVIDIA_VERSION}/nomad-device-nvidia_${NOMAD_DEVICE_NVIDIA_VERSION}_linux_$PLUGIN_ARCH.zip"
(cd "$TMP" && unzip -o plugin.zip >/dev/null)
$SUDO install -m 0755 "$TMP/nomad-device-nvidia" ${NOMAD_PLUGIN_DIR}/nomad-device-nvidia
rm -rf "$TMP"

# 4. Enable the plugin in Nomad's config (idempotent write).
$SUDO tee ${NVIDIA_PLUGIN_HCL} >/dev/null <<'HCL'
plugin "nomad-device-nvidia" {
  config {
    enabled            = true
    fingerprint_period = "1m"
  }
}
HCL

# 5. Restart Nomad so it loads the plugin + fingerprints the GPU(s). A client
#    restart does not kill running allocations.
$SUDO systemctl restart nomad
echo "GPU_SETUP_DONE"
`;
