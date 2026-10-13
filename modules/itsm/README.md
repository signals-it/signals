# ITSM UI module

All new React ticketing screens belong here. Suggested structure when implementation begins:

- `pages/TicketListPage.tsx`
- `pages/TicketDetailsPage.tsx`
- `pages/CreateTicketPage.tsx`
- `components/`
- `hooks/`
- `services/ticketService.ts` — calls our Node.js API, not GLPI directly
- `types/`

GLPI remains the source of truth for its supported ticket workflows unless a future architecture decision explicitly changes that.
