import "server-only";

import { z } from "zod";

export const playerSchema = z
  .object({
    id: z.string().trim().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/),
    name: z.string().trim().min(1).max(100),
    personality: z.string().trim().max(2_000).default(""),
    temperature: z.number().min(0).max(2).optional(),
  })
  .strict();

export const gameConfigSchema = z
  .object({
    players: z.array(playerSchema).min(8).max(18),
    roles: z.array(z.enum(["werewolf", "villager", "seer"])).optional(),
    model: z
      .object({
        base_url: z.string().url().optional(),
        name: z.string().trim().min(1).max(128).optional(),
        max_retries: z.number().int().min(0).max(10).optional(),
        temperature: z.number().min(0).max(2).optional(),
        character_temperature: z.number().min(0).max(2).optional(),
        title_temperature: z.number().min(0).max(2).optional(),
        prompt_style: z.enum(["classic", "social"]).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((config, context) => {
    const ids = new Set<string>();
    for (const player of config.players) {
      if (ids.has(player.id)) {
        context.addIssue({
          code: "custom",
          message: `Player ID "${player.id}" is duplicated.`,
          path: ["players"],
        });
      }
      ids.add(player.id);
    }
    if (config.roles && config.roles.length !== config.players.length) {
      context.addIssue({
        code: "custom",
        message: "roles must contain exactly one role for every player.",
        path: ["roles"],
      });
    }
  });

export const launchRequestSchema = z
  .object({
    config: gameConfigSchema,
    // Optional deterministic seed for the run, as a canonical decimal string. Constraints:
    //  - A run seed is a uint64, which exceeds float64, so it must never be a JSON number
    //    (JSON.parse would silently round it and the launched seed would stop matching the one
    //    recovered later). It is carried as a string end to end.
    //  - The engine parses `-seed` with strconv.ParseUint(s, 0, 64) (base 0), so a leading zero
    //    would be read as octal ("010" -> 8) and octal-invalid digits ("08") would crash the
    //    container. Requiring a canonical decimal form rules both out.
    //  - 20 digits is the most a uint64 can take; anything longer can only fail at the engine.
    //  - Zero is rejected rather than accepted: the engine defines `-seed 0` as "pick a
    //    nondeterministic seed", so a stored "0" would not be the seed the run used, and the two
    //    arms of a same-seed comparison would silently fail to pair. A blank field already means
    //    "random", so there is nothing for a literal 0 to ask for.
    seed: z.string().regex(/^[1-9]\d{0,19}$/, "seed must be a positive decimal integer; leave it blank for a random seed.").optional(),
  })
  .strict();

export type ValidGameConfig = z.infer<typeof gameConfigSchema>;
