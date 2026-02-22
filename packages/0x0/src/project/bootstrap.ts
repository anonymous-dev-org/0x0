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
import { init as initModels } from "../provider/models"

const log = Log.create({ service: "bootstrap" })

function startDeferredInit() {
  return (async () => {
    const started = performance.now()
    try {
      await Plugin.init()
    } catch (e) {
      log.error("plugin init failed", { error: e instanceof Error ? e.message : String(e) })
    }
    try {
      await LSP.init()
    } catch (e) {
      log.error("lsp init failed", { error: e instanceof Error ? e.message : String(e) })
    }
    try {
      await FileWatcher.init()
    } catch (e) {
      log.error("filewatcher init failed", { error: e instanceof Error ? e.message : String(e) })
    }
    try {
      File.init()
    } catch (e) {
      log.error("file init failed", { error: e instanceof Error ? e.message : String(e) })
    }
    try {
      Snapshot.init()
    } catch (e) {
      log.error("snapshot init failed", { error: e instanceof Error ? e.message : String(e) })
    }
    try {
      await initModels()
    } catch (e) {
      log.error("models init failed", { error: e instanceof Error ? e.message : String(e) })
    }
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
  ShareNext.init().catch((e) =>
    log.error("share-next init failed", { error: e instanceof Error ? e.message : String(e) }),
  )
  Format.init()
  Vcs.init().catch((e) => log.error("vcs init failed", { error: e instanceof Error ? e.message : String(e) }))
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
