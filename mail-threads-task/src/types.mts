export type ProviderMessage = {
  message_id: string;
  in_reply_to?: string | null;
  references?: string[] | null;
  subject: string;
  from: string;
  to: string[];
  sent_at: string;
};

export type ProviderPage = {
  items: ProviderMessage[];
  next_cursor: string | null;
};

export type LinkRow = {
  message_id: string;
  position: number;
  target_id: string;
};

export type ThreadAssignment = {
  threadKey: string;
  parentId: string | null;
};
