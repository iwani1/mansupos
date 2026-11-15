import { z } from 'zod';
import { AppError } from './errors.js';
import { audit } from './db.js';

// Operational self-attestations live in the existing append-only POS audit
// journal. No new schema, Woo request, till entry or stock mutation is made.
export const LANES = {
  sales: {
    label:'Sales representative',
    counts:['Customer follow-ups','Orders needing staff handover'],
    tasks:[
      {id:'sales.open',label:'Check opening readiness',detail:'Confirm work area and handover notes; flag exceptions to the owner'},
      {id:'sales.messages',label:'Review incoming enquiries',detail:'Respond to customer enquiries using approved business channels'},
      {id:'sales.details',label:'Check product details before quoting',detail:'Review sizes and current prices; do not promise unverified stock'},
      {id:'sales.followup',label:'Follow up pending customer enquiries',detail:'Record the follow-up count in the daily report, without customer names'},
      {id:'sales.close',label:'Complete closing handover',detail:'Escalate unresolved enquiries and exceptions to the manager'},
    ],
  },
  fulfilment: {
    label:'Fulfilment officer',
    counts:['Orders packed','Dispatch handovers'],
    tasks:[
      {id:'fulfilment.queue',label:'Review authorised fulfilment queue',detail:'Use the original order record, not a screenshot or unverified POS payment'},
      {id:'fulfilment.match',label:'Check item, colour and size',detail:'Confirm goods against the authorised order details before packing'},
      {id:'fulfilment.qa',label:'Perform packing quality check',detail:'Check condition, presentation and label accuracy'},
      {id:'fulfilment.handover',label:'Record dispatch handover',detail:'Use the approved dispatch process; this checkbox is not delivery proof'},
      {id:'fulfilment.close',label:'Escalate remaining work',detail:'Report missing goods, pending dispatches and discrepancies'},
    ],
  },
};
const laneSchema=z.enum(['sales','fulfilment']);
const dayPattern=/^\d{4}-\d{2}-\d{2}$/;
const taskInput=z.object({taskId:z.string().min(1).max(50),done:z.boolean()}).strict();
const reportInput=z.object({
  first:z.number().int().min(0).max(10000),
  second:z.number().int().min(0).max(10000),
  issues:z.number().int().min(0).max(10000),
  note:z.string().trim().max(280).refine(v=>!/[\r\n]/.test(v),'Use one short line without line breaks'),
}).strict();
const assignmentInput=z.object({staffId:z.string().min(1).max(128),lane:laneSchema.nullable()}).strict();
const DAY_MS=86400000;

export function accraDay(now=new Date()){
  const parts=new Intl.DateTimeFormat('en-GB',{timeZone:'Africa/Accra',
    year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now);
  const fields=Object.fromEntries(parts.map(p=>[p.type,p.value]));
  return `${fields.year}-${fields.month}-${fields.day}`;
}
function dayAfter(day){
  return new Date(Date.parse(day+'T00:00:00Z')+DAY_MS).toISOString().slice(0,10);
}
function validDay(date,today){
  if(!dayPattern.test(date) || !Number.isFinite(Date.parse(date+'T00:00:00Z')) ||
      new Date(date+'T00:00:00Z').toISOString().slice(0,10)!==date){
    throw new AppError('Use a valid date in YYYY-MM-DD format.',400);
  }
  const earliest=new Date(Date.parse(today+'T00:00:00Z')-6*DAY_MS).toISOString().slice(0,10);
  if(date<earliest||date>today)throw new AppError('Only today and the preceding six days can be reviewed.',400);
  return date;
}
function parseEvent(subject){
  try {return JSON.parse(subject);} catch {return null;}
}
function currentAssignments(db,cutoff=null){
  const assigned=new Map();
  const sql="SELECT subject FROM audit WHERE action='operations.assignment'"+
    (cutoff?" AND created_at < ?":"")+" ORDER BY created_at ASC,id ASC";
  for(const row of db.prepare(sql).all(...(cutoff?[cutoff]:[]))){
    const data=parseEvent(row.subject);
    if(data?.staffId && (data.lane===null || LANES[data.lane]))assigned.set(data.staffId,data.lane);
  }
  return assigned;
}
function dayEvents(db,day){
  // Accra is UTC+0; all submitted tasks and reports are stamped for the
  // authoritative current Accra day. Indexed time bounds avoid full log reads.
  return db.prepare(`SELECT id,actor,action,subject,created_at FROM audit
    WHERE created_at>=? AND created_at<? AND action IN
    ('operations.task_done','operations.task_reopened','operations.report')
    ORDER BY id ASC`).all(day+'T00:00:00.000Z',dayAfter(day)+'T00:00:00.000Z');
}
function stateFor(member,day,events,assigned){
  const lane=assigned.get(member.id)||null;
  const done=new Set();
  let report=null;
  for(const event of events){
    if(event.actor!==member.id)continue;
    const data=parseEvent(event.subject);
    if(data?.day!==day || data.lane!==lane || !lane)continue;
    if(event.action==='operations.task_done')done.add(data.taskId);
    if(event.action==='operations.task_reopened')done.delete(data.taskId);
    if(event.action==='operations.report')report={
      first:data.first,second:data.second,issues:data.issues,note:data.note,
      submittedAt:event.created_at,
    };
  }
  const tasks=lane?LANES[lane].tasks.map(task=>({...task,done:done.has(task.id)})):[];
  return {
    id:member.id,name:member.name,role:member.role,active:Boolean(member.active),
    lane,laneLabel:lane?LANES[lane].label:null,
    tasks,done:tasks.filter(task=>task.done).length,total:tasks.length,
    report,
  };
}
export class DailyOperations {
  constructor(db){this.db=db;}
  today(){return accraDay();}
  day(date){return validDay(date||this.today(),this.today());}
  self(user,date){
    const day=this.day(date);
    const member=this.db.prepare("SELECT id,name,role,active FROM users WHERE id=?").get(user.id);
    if(!member)throw new AppError('Account not found.',404);
    const status=stateFor(member,day,dayEvents(this.db,day),
      currentAssignments(this.db,day===this.today()?null:dayAfter(day)+'T00:00:00.000Z'));
    return {kind:'local-staff-self-report',date:day,today:this.today(),...status,
      counts:status.lane?LANES[status.lane].counts:[],
      scope:'Staff self-reported activities only; not proof of payment, stock, dispatch or WooCommerce order status.'};
  }
  team(date){
    const day=this.day(date), events=dayEvents(this.db,day);
    const assigned=currentAssignments(this.db,day===this.today()?null:dayAfter(day)+'T00:00:00.000Z');
    const members=this.db.prepare("SELECT id,name,role,active FROM users WHERE role IN ('manager','cashier') ORDER BY name,id").all()
      .map(member=>{
        const state=stateFor(member,day,events,assigned);
        return {id:state.id,name:state.name,role:state.role,active:state.active,
          lane:state.lane,laneLabel:state.laneLabel,done:state.done,total:state.total,
          report:state.report};
      });
    return {kind:'local-staff-operations-team',date:day,today:this.today(),members,
      scope:'Staff self-reports from this POS only. Incomplete tasks and missing reports require follow-up; checkmarks do not verify goods, money or delivery.'};
  }
  assign(user,input){
    if(user.role!=='owner')throw new AppError('Only the owner may assign duties.',403);
    const {staffId,lane}=assignmentInput.parse(input);
    const member=this.db.prepare("SELECT id,name,role,active FROM users WHERE id=?").get(staffId);
    if(!member||member.role==='owner')throw new AppError('Select a staff or manager account.',404);
    if(!member.active)throw new AppError('Inactive accounts cannot receive new duties.',409);
    if((currentAssignments(this.db).get(staffId)??null)!==lane){
      audit(this.db,user.id,'operations.assignment',JSON.stringify({staffId,lane}));
    }
    return {ok:true,staffId,lane};
  }
  setTask(user,input){
    const {taskId,done}=taskInput.parse(input);
    const today=this.today();
    const assigned=currentAssignments(this.db).get(user.id);
    if(!assigned||!LANES[assigned])throw new AppError('Ask the owner to assign your daily duties first.',403);
    const valid=LANES[assigned].tasks.some(item=>item.id===taskId);
    if(!valid)throw new AppError('This task is not assigned to your role.',403);
    const state=this.self(user,today);
    const current=state.tasks.find(item=>item.id===taskId);
    if(current.done!==done) {
      audit(this.db,user.id,done?'operations.task_done':'operations.task_reopened',
        JSON.stringify({day:today,lane:assigned,taskId}));
    }
    return this.self(user,today);
  }
  submit(user,input){
    const values=reportInput.parse(input);
    const lane=currentAssignments(this.db).get(user.id);
    if(!lane||!LANES[lane])throw new AppError('Ask the owner to assign your daily duties first.',403);
    const day=this.today();
    audit(this.db,user.id,'operations.report',JSON.stringify({day,lane,...values}));
    return this.self(user,day);
  }
}
