// Custom HubSpot properties this app reads and writes. `npm run setup`
// creates them; the definitions below are also the reference for creating
// them by hand in Settings > Properties.

export const DEAL = {
  status: 'calc_line_items_status',
  message: 'calc_line_items_message',
  syncedAt: 'calc_line_items_synced_at',
  fingerprint: 'calc_line_items_fingerprint',
  frozen: 'calc_line_items_frozen',
};

// Stored on every line item the app creates: "<calculator id>:<line key>".
// It is how the app recognises its own line items, so it can update them
// instead of creating duplicates, and leave manually added ones alone.
export const LINE_ITEM_KEY = 'calc_line_key';

export const STATUS = {
  synced: 'synced',
  skipped: 'skipped',
  error: 'error',
};

export const PROPERTY_DEFINITIONS = {
  deals: [
    {
      name: DEAL.status,
      label: 'Calculator line items: status',
      description: 'Set by the calculator line items app after each sync.',
      groupName: 'dealinformation',
      type: 'enumeration',
      fieldType: 'select',
      options: [
        { label: 'Ready for review', value: STATUS.synced, displayOrder: 0 },
        { label: 'Skipped', value: STATUS.skipped, displayOrder: 1 },
        { label: 'Needs attention', value: STATUS.error, displayOrder: 2 },
      ],
    },
    {
      name: DEAL.message,
      label: 'Calculator line items: details',
      description: 'What the last sync changed, or why it could not run.',
      groupName: 'dealinformation',
      type: 'string',
      fieldType: 'textarea',
    },
    {
      name: DEAL.syncedAt,
      label: 'Calculator line items: last synced',
      groupName: 'dealinformation',
      type: 'datetime',
      fieldType: 'date',
    },
    {
      name: DEAL.fingerprint,
      label: 'Calculator line items: fingerprint',
      description:
        'Internal. A fingerprint of the calculator output last applied, used to skip syncs when nothing changed. Leave it alone.',
      groupName: 'dealinformation',
      type: 'string',
      fieldType: 'text',
      formField: false,
    },
    {
      name: DEAL.frozen,
      label: 'Calculator line items: freeze',
      description:
        'Tick to stop the app changing this deal\'s line items. Untick to re-sync them from the calculator.',
      groupName: 'dealinformation',
      type: 'bool',
      fieldType: 'booleancheckbox',
      options: [
        { label: 'Yes', value: 'true', displayOrder: 0 },
        { label: 'No', value: 'false', displayOrder: 1 },
      ],
    },
  ],
  line_items: [
    {
      name: LINE_ITEM_KEY,
      label: 'Calculator line key',
      description:
        'Set by the calculator line items app to identify the calculator line that produced this line item. Blank on manually added line items.',
      groupName: 'lineiteminformation',
      type: 'string',
      fieldType: 'text',
    },
  ],
};
