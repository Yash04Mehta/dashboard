-- Extra views for the Aquant Insight app (schema "reporting" comes from reporting_views.sql).
-- Read-only views only: nothing is written to your tables.
-- One row per lead / opportunity, with the known data problems already handled:
--   lead_source shows "(unknown: overwritten by status)" where workflow #7 replaced the real source with a status;
--   phone10 is empty where the phone number was replaced by text, so those leads cannot be linked to messages.

create schema if not exists reporting;
drop view if exists reporting.v_leads, reporting.v_opps cascade;

create or replace view reporting.v_leads as
select
  lead_id,
  owner_id,
  customer_name,
  customer_number,
  reporting.phone10(customer_number)                         as phone10,
  coalesce(customer_number ~ '[A-Za-z]', false)              as phone_overwritten,
  (coalesce(customer_number, '') = '')                       as phone_empty,
  case
    when lead_source in ('Not Connected','New','Contacted','Nurturing','Qualified','Unqualified') then '(unknown: overwritten by status)'
    when coalesce(lead_source, '') = '' then '(none)'
    else lead_source
  end                                                        as lead_source,
  coalesce(lead_source in ('Not Connected','New','Contacted','Nurturing','Qualified','Unqualified'), false) as source_overwritten,
  coalesce(lead_status, '(none)')                            as lead_status,
  coalesce(lead_manager_name, '(unassigned)')                as lead_owner,
  page_url,
  coalesce(welcome_message, 0)                               as welcome,
  coalesce(first_follow_up_message_after24hr, 0)             as followup_24h,
  coalesce("1st_follow_up_message", 0)                       as task1,
  coalesce("2nd_follow_up_message", 0)                       as task2,
  coalesce("3rd_follow_up_message", 0)                       as task3,
  coalesce(when_lead_converted_into_nurturing, 0)            as to_nurturing,
  coalesce(when_lead_converted_into_not_connected, 0)        as to_not_connected,
  coalesce(when_lead_converted_into_unqualified, 0)          as to_unqualified,
  created_at,
  updated_at,
  created_at::date                                           as created_date
from public.lead_insight;

create or replace view reporting.v_opps as
select
  opportunity_id,
  owner_id,
  customer_name,
  customer_number,
  reporting.phone10(customer_number)                         as phone10,
  coalesce(opportunity_status, '(none)')                     as opportunity_status,
  coalesce(opportunity_manager_name, '(unassigned)')         as opp_owner,
  coalesce(lead_manager_name, '')                            as lead_owner,
  coalesce(send_customer_details_to_salesperson, 0)          as details_to_salesperson,
  coalesce(send_salesman_details_to_customer, 0)             as details_to_customer,
  coalesce("1st_follow_up_message_after_48hr", 0)            as followup_48h,
  coalesce("2nd_follow_up_message_after_24hr", 0)            as followup_24h,
  coalesce(opportunity_won, 0)                               as won_flag,
  coalesce(opportunity_loss, 0)                              as loss_flag,
  created_at,
  updated_at,
  created_at::date                                           as created_date
from public.opportunity_insight;
