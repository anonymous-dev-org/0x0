import type { TextareaRenderable } from "@opentui/core"
import type { PromptInfo } from "./history"

export function usePromptParts(props: {
  input: () => TextareaRenderable
  promptPartTypeId: () => number
  fileStyleId: number
  agentStyleId: number
  pasteStyleId: number
  getParts: () => PromptInfo["parts"]
  getMap: () => Map<number, number>
  setParts: (parts: PromptInfo["parts"]) => void
  setMap: (map: Map<number, number>) => void
}) {
  function restore(parts: PromptInfo["parts"]) {
    const input = props.input()
    input.extmarks.clear()
    const nextMap = new Map<number, number>()

    for (const [partIndex, part] of parts.entries()) {
      let start = 0
      let end = 0
      let virtualText = ""
      let styleId: number | undefined

      if (part.type === "file" && part.source?.text) {
        start = part.source.text.start
        end = part.source.text.end
        virtualText = part.source.text.value
        styleId = props.fileStyleId
      } else if (part.type === "agent" && part.source) {
        start = part.source.start
        end = part.source.end
        virtualText = part.source.value
        styleId = props.agentStyleId
      } else if (part.type === "text" && part.source?.text) {
        start = part.source.text.start
        end = part.source.text.end
        virtualText = part.source.text.value
        styleId = props.pasteStyleId
      }

      if (!virtualText) continue
      const extmarkId = input.extmarks.create({
        start,
        end,
        virtual: true,
        styleId,
        typeId: props.promptPartTypeId(),
      })
      nextMap.set(extmarkId, partIndex)
    }

    props.setMap(nextMap)
  }

  function sync() {
    const input = props.input()
    const allExtmarks = input.extmarks.getAllForTypeId(props.promptPartTypeId())
    const parts = props.getParts()
    const map = props.getMap()
    const nextMap = new Map<number, number>()
    const nextParts: PromptInfo["parts"] = []

    for (const extmark of allExtmarks) {
      const partIndex = map.get(extmark.id)
      if (partIndex === undefined) continue
      const part = parts[partIndex]
      if (!part) continue

      if (part.type === "agent" && part.source) {
        nextMap.set(extmark.id, nextParts.length)
        nextParts.push({
          ...part,
          source: {
            ...part.source,
            start: extmark.start,
            end: extmark.end,
          },
        })
        continue
      }

      if (part.type === "file" && part.source?.text) {
        nextMap.set(extmark.id, nextParts.length)
        nextParts.push({
          ...part,
          source: {
            ...part.source,
            text: {
              ...part.source.text,
              start: extmark.start,
              end: extmark.end,
            },
          },
        })
        continue
      }

      if (part.type === "text" && part.source?.text) {
        nextMap.set(extmark.id, nextParts.length)
        nextParts.push({
          ...part,
          source: {
            ...part.source,
            text: {
              ...part.source.text,
              start: extmark.start,
              end: extmark.end,
            },
          },
        })
        continue
      }

      nextMap.set(extmark.id, nextParts.length)
      nextParts.push(part)
    }

    props.setMap(nextMap)
    props.setParts(nextParts)
  }

  return { restore, sync }
}
