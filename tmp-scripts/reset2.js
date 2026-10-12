const { PrismaClient } = require('@prisma/client')
async function main() {
  const db = new PrismaClient()
  await db.guestUsage.update({ where: { guestId: '93d2bf1c-510e-4ff9-b8fa-dbcd4b2e90b4' }, data: { chatCount: 0 } })
  console.log('quota reset para el navegador de prueba')
  await db.$disconnect()
}
main()
