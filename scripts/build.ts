// Builds dist/obs-video-trigger.exe. The version stamped into the exe comes
// from package.json so there is one place to bump it; the release workflow
// checks that the git tag matches.
import pkg from "../package.json";

const version = process.env.BUILD_VERSION ?? pkg.version;

const result = Bun.spawnSync(
  [
    "bun",
    "build",
    "--compile",
    "--minify",
    "--target=bun-windows-x64",
    "--windows-hide-console",
    "--windows-title=OBS Video Trigger",
    "--windows-description=Plays a clip once in an OBS browser source",
    `--windows-version=${version}.0`,
    "--outfile",
    "dist/obs-video-trigger.exe",
    "src/main.ts",
  ],
  { stdout: "inherit", stderr: "inherit" },
);

process.exit(result.exitCode);
