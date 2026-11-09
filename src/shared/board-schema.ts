/**
 * The one definition of a board operation and of the board route's request, as zod schemas; the
 * `BoardOp` type is derived from them. Only the host imports the schemas; shared code and the
 * client import the type only, so zod is never bundled into the browser module.
 */
import { z } from 'zod'
import { SIDES } from './board.ts'

const id = z.string().min(1).max(200)
/** JSON Canvas positions and sizes are integers. */
const coordinate = z.int().min(-10_000_000).max(10_000_000)
const size = z.int().min(1).max(1_000_000)
const text = z.string().max(20_000)
const color = z.string().regex(/^(?:[1-6]|#[0-9a-fA-F]{3}|#[0-9a-fA-F]{6})$/u, 'color 是 "1" 到 "6" 或 #rgb / #rrggbb')

export const boardOpSchema = z.discriminatedUnion('op', [
  /** Drag, resize or retained recovery: exactly the supplied absolute fields (at least one). */
  z.strictObject({ op: z.literal('place'), id, x: coordinate.optional(), y: coordinate.optional(), width: size.optional(), height: size.optional() })
    .refine(op => op.x !== undefined || op.y !== undefined || op.width !== undefined || op.height !== undefined, 'place 至少需要一个坐标或尺寸'),
  /** A new sticky note (a text node); never replaces an existing element. */
  z.strictObject({ op: z.literal('addNote'), id, text, x: coordinate, y: coordinate, width: size, height: size, color: color.optional() }),
  /** New note text, only while the note still reads `ifText`. */
  z.strictObject({ op: z.literal('setText'), id, text, ifText: text }),
  z.strictObject({ op: z.literal('addEdge'), id, fromNode: id, toNode: id, fromSide: z.enum(SIDES).optional(), toSide: z.enum(SIDES).optional(), label: z.string().max(500).optional() }),
  z.strictObject({ op: z.literal('removeEdge'), id }),
  /** Remove nodes and every edge touching them. */
  z.strictObject({ op: z.literal('removeNodes'), ids: z.array(id).min(1).max(200) }),
])

/** Both board endpoints resolve the same canonical file; relative paths require a Session. */
export const boardQuerySchema = z.strictObject({
  sessionId: z.string().min(1).optional(),
  path: z.string().min(1),
})

/** `POST /api/canvas/board`: edit the file OR accept an overwrite of retained batches. */
export const boardPostSchema = z.union([
  boardQuerySchema.extend({ ops: z.array(boardOpSchema).min(1).max(200) }),
  boardQuerySchema.extend({ decline: z.array(id).min(1).max(200) }),
])

export type BoardOp = z.infer<typeof boardOpSchema>
