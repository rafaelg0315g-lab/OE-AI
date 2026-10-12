const { PrismaClient } = require('@prisma/client')
async function main() {
  const db = new PrismaClient()
  const all = await db.guestUsage.findMany()
  console.log('GuestUsage rows:', all.map((g) => `${g.guestId.slice(0, 8)}… used=${g.chatCount}`))
  await db.$disconnect()
}
main()
