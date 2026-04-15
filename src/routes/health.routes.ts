import { Hono } from 'hono'

const healthRoutes = new Hono()

healthRoutes.get('/', (c) => {
  return c.text('Email Lead Generation API is running!')
})

export default healthRoutes
