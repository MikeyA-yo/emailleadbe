import { Hono } from 'hono'
import { Group } from '../db.js'

const groupsRoutes = new Hono()

// Get all groups
groupsRoutes.get('/api/groups', async (c) => {
  try {
    const groups = await Group.find().sort({ createdAt: -1 })
    return c.json(groups)
  } catch (err: any) {
    return c.json({ error: 'Failed to fetch groups', details: err.message }, 500)
  }
})

// Create a new group
groupsRoutes.post('/api/groups', async (c) => {
  try {
    const body = await c.req.json()
    if (!body.name) {
      return c.json({ error: 'Group name is required' }, 400)
    }
    const newGroup = await Group.create({ name: body.name, contacts: [] })
    return c.json(newGroup, 201)
  } catch (err: any) {
    return c.json({ error: 'Failed to create group', details: err.message }, 500)
  }
})

// Replace contacts in a group
groupsRoutes.put('/api/groups/:id/contacts', async (c) => {
  try {
    const groupId = c.req.param('id')
    const { contacts } = await c.req.json()

    if (!Array.isArray(contacts)) {
      return c.json({ error: 'Contacts must be an array' }, 400)
    }

    const group = await Group.findByIdAndUpdate(
      groupId,
      { contacts },
      { new: true }
    )

    if (!group) return c.json({ error: 'Group not found' }, 404)
    return c.json(group)
  } catch (err: any) {
    return c.json({ error: 'Failed to update group contacts', details: err.message }, 500)
  }
})

// Append contacts to a group
groupsRoutes.post('/api/groups/:id/contacts', async (c) => {
  try {
    const groupId = c.req.param('id')
    const { contacts } = await c.req.json()

    if (!Array.isArray(contacts)) {
      return c.json({ error: 'Contacts must be an array' }, 400)
    }

    const group = await Group.findById(groupId)
    if (!group) return c.json({ error: 'Group not found' }, 404)

    const newContacts = contacts.filter((cc: any) => !group.contacts.some((exc: any) => exc.identifier === cc.identifier))
    group.contacts.push(...newContacts)
    await group.save()

    return c.json(group)
  } catch (err: any) {
    return c.json({ error: 'Failed to add contacts to group', details: err.message }, 500)
  }
})

// Remove a contact from a group
groupsRoutes.delete('/api/groups/:id/contacts/:identifier', async (c) => {
  try {
    const groupId = c.req.param('id')
    const identifier = decodeURIComponent(c.req.param('identifier'))

    const group = await Group.findById(groupId)
    if (!group) return c.json({ error: 'Group not found' }, 404)

    group.contacts = group.contacts.filter((contact: any) => contact.identifier !== identifier)
    await group.save()

    return c.json(group)
  } catch (err: any) {
    return c.json({ error: 'Failed to remove contact from group', details: err.message }, 500)
  }
})

export default groupsRoutes
