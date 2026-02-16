import { Plugin } from "../plugin"
import { Share } from "../share/share"
import { Format } from "../format"
import { LSP } from "../lsp"
import { FileWatcher } from "../file/watcher"
import { File } from "../file"
import { Project } from "./project"
import { Bus } from "../bus"
import { Command } from "../command"
import { Instance } from "./instance"
import { Vcs } from "./vcs"
import { Log } from "@/util/log"
import { ShareNext } from "@/share/share-next"
import { Snapshot } from "../snapshot"
import { Truncate } from "../tool/truncation"

function startDeferredInit() {
  return (async () => {
    const started = performance.now()
    await Plugin.init()
    await LSP.init()
    FileWatcher.init()
    File.init()
    Snapshot.init()
    Log.Default.debug("startup", {
      stage: "instance.bootstrap.deferred.complete",
      duration_ms: Math.round(performance.now() - started),
    })
  })().catch((error) => {
    Log.Default.error("instance bootstrap deferred init failed", {
      error: error instanceof Error ? error.message : String(error),
    })
  })
}

export async function InstanceBootstrap() {
  const started = performance.now()
  Log.Default.info("bootstrapping", { directory: Instance.directory })

  Share.init()
  ShareNext.init()
  Format.init()
  Vcs.init()
  Truncate.init()
  void startDeferredInit()

  Log.Default.debug("startup", {
    stage: "instance.bootstrap.critical.complete",
    duration_ms: Math.round(performance.now() - started),
  })

  Bus.subscribe(Command.Event.Executed, async (payload) => {
    if (payload.properties.name === Command.Default.INIT) {
      await Project.setInitialized(Instance.project.id)
    }
  })
}
