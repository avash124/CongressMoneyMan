-- Add the member portrait URL (Congress.gov `depiction.imageUrl`) to the roster.
-- Populated by the sync-members ETL; nullable so members without a published
-- photo (and rows predating this column) simply fall back to an initials avatar.
alter table members add column if not exists image_url text;
