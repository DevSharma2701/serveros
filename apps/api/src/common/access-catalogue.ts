import type { PrismaClient } from '@prisma/client';
import { ALL_PERMISSIONS, PERMISSIONS, SYSTEM_ROLES } from '@serveos/shared';

/**
 * Writes the permission catalogue and the built-in roles to the database.
 * Safe to run repeatedly; the API runs it on every start and the seed script uses it too.
 */
export async function syncAccessCatalogue(prisma: PrismaClient): Promise<void> {
  for (const key of ALL_PERMISSIONS) {
    const [category, description] = PERMISSIONS[key];
    await prisma.permission.upsert({ where: { key }, create: { key, category, description }, update: { category, description } });
  }
  await prisma.permission.deleteMany({ where: { key: { notIn: ALL_PERMISSIONS } } });
  for (const [key, def] of Object.entries(SYSTEM_ROLES)) {
    const existing = await prisma.role.findFirst({ where: { restaurantId: null, key } });
    const role = existing
      ? await prisma.role.update({ where: { id: existing.id }, data: { name: def.name, rank: def.rank, isSystem: true } })
      : await prisma.role.create({ data: { key, name: def.name, rank: def.rank, isSystem: true } });
    await prisma.rolePermission.deleteMany({ where: { roleId: role.id, permissionKey: { notIn: def.permissions } } });
    await prisma.rolePermission.createMany({
      data: def.permissions.map((permissionKey) => ({ roleId: role.id, permissionKey })),
      skipDuplicates: true,
    });
  }
}
