import { randomUUID } from "node:crypto";
import type { SandboxHandle } from "@i-bot/core";
import { PrepareWebProjectInput, WebProjectRuntime } from "@i-bot/types";
import { tool, type Tool } from "ai";

export const WEB_PROJECT_CONFIG = ".ibot-web.json";
export async function readWebProjectRuntime(handle: SandboxHandle, projectDir: string) {
  const path = `${projectDir}/${WEB_PROJECT_CONFIG}`;
  if (!(await handle.files.exists(path))) return null;
  const value = WebProjectRuntime.parse(JSON.parse(await handle.files.readText(path)));
  if (value.projectDir !== projectDir) throw new Error("Project configuration mismatch");
  return value;
}

// The lock covers selecting a port and recording its allocation. Listening processes and other
// prepared projects both count as occupied, even when those projects are temporarily stopped.
export const PREPARE_PROJECT_SCRIPT = `python3 - <<'IBOT_PREPARE_PY'
import os,json,pathlib,socket,fcntl
root=pathlib.Path('/root/projects')
root.mkdir(parents=True,exist_ok=True)
config=json.loads(os.environ['IBOT_WEB_CONFIG'])
project=pathlib.Path(config['projectDir'])
with (root/'.ibot-web.lock').open('a') as lock:
    fcntl.flock(lock,fcntl.LOCK_EX)
    if project.exists():
        print(json.dumps({'ok':False,'error':'Project directory already exists; read and reuse it without overwriting'}))
    else:
        occupied=set()
        for directory,dirs,files in os.walk(root):
            dirs[:]=[name for name in dirs if name not in ('node_modules','.next','.git','dist')]
            if '.ibot-web.json' in files:
                try:
                    occupied.add(json.loads((pathlib.Path(directory)/'.ibot-web.json').read_text())['port'])
                except (OSError,ValueError,KeyError):
                    pass
        requested=config.get('port')
        candidates=[requested] if requested is not None else range(5173,5900)
        selected=None
        for port in candidates:
            if port in occupied:
                continue
            probe=socket.socket()
            try:
                probe.bind(('0.0.0.0',port))
                selected=port
                break
            except OSError:
                pass
            finally:
                probe.close()
        if selected is None:
            print(json.dumps({'ok':False,'error':'Requested port is occupied or no default application port is available'}))
        else:
            config['port']=selected
            project.mkdir(parents=True,exist_ok=False)
            (project/'.ibot-web.json').write_text(json.dumps(config,ensure_ascii=False,indent=2)+'\\n')
            print(json.dumps({'ok':True,'project':config}))
IBOT_PREPARE_PY`;

/** Small first-party starters. Versions were checked against the npm registry on 2026-09-29. */
export function webProjectStarter(
  project: WebProjectRuntime,
  hostname: string,
): Record<string, string> {
  const next = project.framework === "nextjs";
  const packageJson = {
    name: project.projectDir.split("/").at(-1)!.toLowerCase(),
    private: true,
    version: "0.0.0",
    type: "module",
    scripts: next
      ? {
          dev: `next dev --hostname 0.0.0.0 --port ${project.port}`,
          build: "next build",
          start: `next start --hostname 0.0.0.0 --port ${project.port}`,
        }
      : { dev: "vite", build: "tsc --noEmit && vite build", preview: "vite preview" },
    dependencies: { react: "19.3.0", "react-dom": "19.3.0", ...(next ? { next: "16.3.6" } : {}) },
    devDependencies: {
      typescript: "5.9.3",
      "@types/react": "19.3.0",
      "@types/react-dom": "19.3.0",
      "@types/node": "26.6.3",
      ...(!next ? { vite: "8.3.1", "@vitejs/plugin-react": "6.1.1" } : {}),
    },
  };
  const tsconfig = {
    compilerOptions: {
      target: "ES2022",
      lib: ["ES2022", "DOM", "DOM.Iterable"],
      module: "ESNext",
      moduleResolution: "Bundler",
      jsx: next ? "preserve" : "react-jsx",
      strict: true,
      skipLibCheck: true,
      noEmit: true,
      esModuleInterop: true,
      resolveJsonModule: true,
      ...(next ? { plugins: [{ name: "next" }] } : {}),
    },
    include: next
      ? ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts", ".next/dev/types/**/*.ts"]
      : ["src", "vite.config.ts"],
    exclude: ["node_modules"],
  };
  const app = `export default function App() { return <main><h1>${"网页创作"}</h1><p>根据项目 design.md 实现内容和交互。</p></main>; }\n`;
  const shared = {
    "package.json": JSON.stringify(packageJson, null, 2) + "\n",
    "tsconfig.json": JSON.stringify(tsconfig, null, 2) + "\n",
    ".gitignore": "node_modules\ndist\n.next\n.web-dev.log\n",
  };
  if (next)
    return {
      ...shared,
      "src/app/page.tsx": app,
      "src/app/layout.tsx":
        'import "./globals.css";\nexport default function RootLayout({ children }: { children: React.ReactNode }) { return <html lang="zh-CN"><body>{children}</body></html>; }\n',
      "src/app/globals.css": "body { margin: 0; font-family: system-ui, sans-serif; }\n",
      "next.config.ts": `import type { NextConfig } from "next";\nconst config: NextConfig = { allowedDevOrigins: [${JSON.stringify(hostname)}] };\nexport default config;\n`,
    };
  return {
    ...shared,
    "index.html":
      '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/><title>网页创作</title></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>\n',
    "src/main.tsx":
      'import { createRoot } from "react-dom/client";\nimport App from "./App";\nimport "./styles.css";\ncreateRoot(document.getElementById("root")!).render(<App />);\n',
    "src/App.tsx": app,
    "src/styles.css": "body { margin: 0; font-family: system-ui, sans-serif; }\n",
    "vite.config.ts": `import { defineConfig } from "vite";\nimport react from "@vitejs/plugin-react";\nexport default defineConfig({ plugins: [react()], server: { host: "0.0.0.0", port: ${project.port}, strictPort: true, allowedHosts: [${JSON.stringify(hostname)}] }, preview: { host: "0.0.0.0", port: ${project.port}, strictPort: true, allowedHosts: [${JSON.stringify(hostname)}] } });\n`,
  };
}

type Result =
  | {
      ok: true;
      project: WebProjectRuntime;
      installCommand: string;
      buildCommand: string;
      startCommand: string;
      previewInput: { projectDir: string };
      guidance: string;
    }
  | { ok: false; error: string };
export function buildPrepareWebProjectTool(
  handle: SandboxHandle,
): Tool<PrepareWebProjectInput, Result> {
  return tool({
    description:
      "Initialize a NEW web project without asking the user for a path, framework, port or preview instructions. Provide only its human title for defaults: unique /root/projects folder, React+TypeScript+Vite, free app port, exact allowed sandbox hostname and starter files. Choose nextjs only when server-side needs justify it. Existing projects must be read and reused, never reinitialized. Install dependencies, replace the starter with real content/design, build and start, then call preview_web with the returned projectDir automatically.",
    inputSchema: PrepareWebProjectInput,
    async execute(input): Promise<Result> {
      const parsed = PrepareWebProjectInput.safeParse(input);
      if (!parsed.success)
        return { ok: false, error: "Invalid project title, path, framework or port" };
      const prefix =
        parsed.data.title
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "")
          .slice(0, 40) || "web";
      const projectDir =
        parsed.data.projectDir ?? `/root/projects/${prefix}-${randomUUID().slice(0, 8)}`;
      try {
        const result = await handle.run(PREPARE_PROJECT_SCRIPT, {
          timeoutMs: 20000,
          env: { IBOT_WEB_CONFIG: JSON.stringify({ ...parsed.data, projectDir }) },
        });
        if (result.exitCode !== 0)
          return {
            ok: false,
            error:
              "Could not prepare project. Check Python and sandbox connection; do not assume it was created",
          };
        const raw = JSON.parse(result.stdout);
        if (raw.ok !== true) return { ok: false, error: raw.error ?? "Could not allocate project" };
        const project = WebProjectRuntime.parse(raw.project);
        if (project.projectDir !== projectDir)
          return { ok: false, error: "Project directory mismatch" };
        const files = webProjectStarter(project, handle.getHost(project.port));
        await Promise.all(
          Object.entries(files).map(([path, content]) =>
            handle.files.write(`${projectDir}/${path}`, content),
          ),
        );
        // Paths have passed the shared safe-directory schema, so these contain no shell metacharacters.
        const cd = `cd ${projectDir}`;
        return {
          ok: true,
          project,
          installCommand: `${cd} && npm install`,
          buildCommand: `${cd} && npm run build`,
          startCommand: `${cd} && python3 -c 'import subprocess,pathlib; log=open(".web-dev.log","a"); process=subprocess.Popen(["npm","run","dev"],stdin=subprocess.DEVNULL,stdout=log,stderr=subprocess.STDOUT,start_new_session=True); pathlib.Path(".web-dev.pid").write_text(str(process.pid)); print(process.pid)'`,
          previewInput: { projectDir },
          guidance:
            "Starter is unfinished. Implement real content and independent design.md, install (save package-lock.json), build, start and automatically register preview. Do not ask the user to supply technical defaults. Keep the returned strict port; if startup reports a conflict, resolve it explicitly rather than silently opening the wrong service.",
        };
      } catch {
        return {
          ok: false,
          error: `Project preparation failed. Inspect ${projectDir} before retrying; keep any files already written`,
        };
      }
    },
  });
}
