import type { ComputerRef } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { planComputerSize } from "@rakazo/db";
import { toComputerRef } from "./screens/computer-support.js";

/**
 * A reference to a running computer that, if a call through it has to wake the machine, starts
 * it at its planned size. Kept out of the screen helpers, which the desktop app bundles without
 * the database.
 */
export async function wakeableComputerRef(
  prisma: Pick<PrismaClient, "computer">,
  computer: Parameters<typeof toComputerRef>[0] & { id: string },
): Promise<ComputerRef> {
  return { ...toComputerRef(computer), startSize: await planComputerSize(prisma, computer.id) };
}
