/**
 * Shape of a single item as returned by the mail provider's /v1/messages feed.
 */
export interface ProviderMessage {
  message_id: string;
  in_reply_to: string | null;
  references: string[] | null;
  subject: string | null;
  from: string | null;
  to: string[] | null;
  sent_at: string;
}

export interface ProviderPage {
  items: ProviderMessage[];
  next_cursor: string | null;
}

/**
 * Row shape as stored in / read back from the `messages` table.
 * references_json is the JSON-encoded array as received from the provider.
 */
export interface MessageRow {
  external_id: string;
  in_reply_to: string | null;
  references_json: string;
  subject: string | null;
  from_addr: string | null;
  to_addr: string | null;
  sent_at: string | null;
}

/**
 * One line of the final export file.
 */
export interface ExportRecord {
  external_id: string;
  thread_key: string;
  parent_id: string;
  sent_at: string | null;
  subject: string | null;
}
