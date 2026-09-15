const express=require("express");
const session=require("express-session");
const bcrypt=require("bcryptjs");
const path=require("path");
const fs=require("fs");

class SqlJsDatabase {
  constructor(SQL,file){this.SQL=SQL;this.file=file;this.db=null;this.inTransaction=false}
  init(){if(fs.existsSync(this.file)){this.db=new this.SQL.Database(fs.readFileSync(this.file))}else{this.db=new this.SQL.Database()}this.db.run("PRAGMA foreign_keys = ON");return this}
  save(){fs.writeFileSync(this.file,Buffer.from(this.db.export()))}
  exec(sql){this.db.run(sql);if(!this.inTransaction)this.save()}
  prepare(sql){const owner=this;return{
    get(...params){const st=owner.db.prepare(sql);try{st.bind(params);return st.step()?st.getAsObject():undefined}finally{st.free()}},
    all(...params){const st=owner.db.prepare(sql),out=[];try{st.bind(params);while(st.step())out.push(st.getAsObject());return out}finally{st.free()}},
    run(...params){const st=owner.db.prepare(sql);try{st.bind(params);st.step()}finally{st.free()}const last=owner.db.exec("SELECT last_insert_rowid() AS n")[0]?.values[0]?.[0]??0;const result={lastInsertRowid:Number(last),changes:owner.db.getRowsModified()};if(!owner.inTransaction)owner.save();return result}
  }}
  transaction(fn){const owner=this;return function(){owner.db.run("BEGIN");owner.inTransaction=true;try{const result=fn();owner.db.run("COMMIT");owner.inTransaction=false;owner.save();return result}catch(e){try{owner.db.run("ROLLBACK")}finally{owner.inTransaction=false}throw e}}}
}
async function createDatabase(file){const initSqlJs=require("sql.js");const SQL=await initSqlJs({locateFile:name=>path.join(__dirname,"node_modules","sql.js","dist",name)});return new SqlJsDatabase(SQL,file).init()}

const PORT=Number(process.env.PORT||3000);
const SCHOOL_NAME=process.env.SCHOOL_NAME||"KWIHOTA SCHOOL";
const DB_FILE=process.env.DB_FILE||path.join(__dirname,"data-annual.sqlite");

async function main(){
const db=await createDatabase(DB_FILE);

db.exec(`
CREATE TABLE IF NOT EXISTS staff_profiles(
 id INTEGER PRIMARY KEY AUTOINCREMENT,email TEXT NOT NULL UNIQUE,password_hash TEXT NOT NULL,
 full_name TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS user_roles(
 staff_id INTEGER PRIMARY KEY REFERENCES staff_profiles(id) ON DELETE CASCADE,
 role TEXT NOT NULL CHECK(role IN ('admin','staff'))
);
CREATE TABLE IF NOT EXISTS annual_fees(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 year INTEGER NOT NULL UNIQUE,
 standard_fee_cents INTEGER NOT NULL CHECK(standard_fee_cents>=0),
 active INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS parents(
 id INTEGER PRIMARY KEY AUTOINCREMENT,parent_code TEXT UNIQUE,name TEXT NOT NULL,phone TEXT NOT NULL,email TEXT,notes TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
 
CREATE TABLE IF NOT EXISTS learners(
 id INTEGER PRIMARY KEY AUTOINCREMENT,parent_id INTEGER NOT NULL REFERENCES parents(id) ON DELETE RESTRICT,
 name TEXT NOT NULL,grade TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS family_annual_charges(
 id INTEGER PRIMARY KEY AUTOINCREMENT,parent_id INTEGER NOT NULL REFERENCES parents(id) ON DELETE CASCADE,
 annual_fee_id INTEGER NOT NULL REFERENCES annual_fees(id) ON DELETE CASCADE,
 amount_cents INTEGER NOT NULL CHECK(amount_cents>=0),
 UNIQUE(parent_id,annual_fee_id)
);
CREATE TABLE IF NOT EXISTS payments(
 id INTEGER PRIMARY KEY AUTOINCREMENT,parent_id INTEGER NOT NULL REFERENCES parents(id) ON DELETE RESTRICT,
 annual_fee_id INTEGER NOT NULL REFERENCES annual_fees(id) ON DELETE RESTRICT,
 amount_cents INTEGER NOT NULL CHECK(amount_cents>0),payment_date TEXT NOT NULL,
 method TEXT NOT NULL CHECK(method IN ('Cash','M-Pesa','Bank transfer','Cheque')),
 reference TEXT NOT NULL,note TEXT,receipt_no INTEGER NOT NULL UNIQUE,
 recorded_by INTEGER NOT NULL REFERENCES staff_profiles(id),created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_learners_parent ON learners(parent_id);
CREATE INDEX IF NOT EXISTS idx_family_charges_year_parent ON family_annual_charges(annual_fee_id,parent_id);
CREATE INDEX IF NOT EXISTS idx_payments_year_parent_date ON payments(annual_fee_id,parent_id,payment_date);
CREATE INDEX IF NOT EXISTS idx_payments_reference ON payments(reference);
`);

try { db.run("ALTER TABLE parents ADD COLUMN parent_code TEXT"); } catch(e) {}
try {
  const missing = db.prepare("SELECT id FROM parents WHERE parent_code IS NULL OR parent_code='' ORDER BY id").all();
  for (const p of missing) db.prepare("UPDATE parents SET parent_code=? WHERE id=?").run("P"+String(p.id).padStart(3,"0"), p.id);
  db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_parents_parent_code ON parents(parent_code)");
} catch(e) {}

function seed(){
 const count=db.prepare("SELECT COUNT(*) n FROM staff_profiles").get().n;
 if(!count){
   const email=process.env.ADMIN_EMAIL||"admin@school.local";
   const password=process.env.ADMIN_PASSWORD||"ChangeThisPassword123!";
   const hash=bcrypt.hashSync(password,12);
   const r=db.prepare("INSERT INTO staff_profiles(email,password_hash,full_name) VALUES(?,?,?)").run(email,hash,"System Administrator");
   db.prepare("INSERT INTO user_roles(staff_id,role) VALUES(?,?)").run(r.lastInsertRowid,"admin");
 }
 if(!db.prepare("SELECT COUNT(*) n FROM annual_fees").get().n){
   db.prepare("INSERT INTO annual_fees(year,standard_fee_cents,active) VALUES(?,?,1)").run(2026,20000);
   db.prepare("INSERT INTO annual_fees(year,standard_fee_cents,active) VALUES(?,?,0)").run(2027,40000);
 }
}
seed();

const app=express();
  app.set("trust proxy",1);
  
app.use(express.json());
app.use(express.urlencoded({extended:false}));
app.use(session({
 secret:process.env.SESSION_SECRET||"dev-only-change-this-secret",
 resave:false,saveUninitialized:false,
 cookie:{httpOnly:true,sameSite:"lax",secure:process.env.NODE_ENV==="production",maxAge:8*60*60*1000}
}));

const auth=(req,res,next)=>{if(!req.session.staffId)return res.status(401).json({error:"Authentication required"});next()};
const admin=(req,res,next)=>{const r=db.prepare("SELECT role FROM user_roles WHERE staff_id=?").get(req.session.staffId);if(!r||r.role!=="admin")return res.status(403).json({error:"Admin access required"});next()};
const validMethods=new Set(["Cash","M-Pesa","Bank transfer","Cheque"]);

app.post("/api/login",(req,res)=>{
 const {email,password}=req.body;
 const staff=db.prepare("SELECT s.*,r.role FROM staff_profiles s JOIN user_roles r ON r.staff_id=s.id WHERE lower(s.email)=lower(?)").get(email||"");
 if(!staff||!bcrypt.compareSync(password||"",staff.password_hash))return res.status(401).json({error:"Invalid email or password"});
 req.session.staffId=staff.id;res.json({id:staff.id,email:staff.email,fullName:staff.full_name,role:staff.role});
});
app.post("/api/logout",(req,res)=>req.session.destroy(()=>res.json({ok:true})));
app.get("/api/me",(req,res)=>{if(!req.session.staffId)return res.status(401).json({error:"Not signed in"});const s=db.prepare("SELECT s.id,s.email,s.full_name fullName,r.role FROM staff_profiles s JOIN user_roles r ON r.staff_id=s.id WHERE s.id=?").get(req.session.staffId);res.json(s)});

app.get("/api/annual-fees",auth,(req,res)=>res.json(db.prepare("SELECT * FROM annual_fees ORDER BY year DESC").all()));
app.post("/api/annual-fees",auth,admin,(req,res)=>{
 const {year,standardFeeCents}=req.body;
 if(!Number.isInteger(Number(year))||Number(year)<2020||!Number.isInteger(standardFeeCents)||standardFeeCents<0)return res.status(400).json({error:"Invalid year or annual fee"});
 try{const r=db.prepare("INSERT INTO annual_fees(year,standard_fee_cents) VALUES(?,?)").run(Number(year),standardFeeCents);res.json(db.prepare("SELECT * FROM annual_fees WHERE id=?").get(r.lastInsertRowid))}
 catch(e){res.status(400).json({error:"That year already exists"})}
});
app.put("/api/annual-fees/:id",auth,admin,(req,res)=>{
 const {year,standardFeeCents}=req.body;
 if(!Number.isInteger(Number(year))||!Number.isInteger(standardFeeCents)||standardFeeCents<0)return res.status(400).json({error:"Invalid year or annual fee"});
 try{db.prepare("UPDATE annual_fees SET year=?,standard_fee_cents=? WHERE id=?").run(Number(year),standardFeeCents,req.params.id);res.json({ok:true})}
 catch(e){res.status(400).json({error:"Could not update annual fee"})}
});
app.post("/api/annual-fees/:id/activate",auth,admin,(req,res)=>{
 const tx=db.transaction(()=>{db.prepare("UPDATE annual_fees SET active=0").run();db.prepare("UPDATE annual_fees SET active=1 WHERE id=?").run(req.params.id)});
 try{tx();res.json({ok:true})}catch(e){res.status(400).json({error:"Could not activate year"})}
});
function activeYear(){return db.prepare("SELECT * FROM annual_fees WHERE active=1 LIMIT 1").get()}

app.get("/api/parents",auth,(req,res)=>{
 const y=activeYear(),q=(req.query.q||"").trim();
 const rows=db.prepare(`
 SELECT p.*,COUNT(DISTINCT l.id) children_count,
 COALESCE(fc.amount_cents,y.standard_fee_cents) charged_cents,
 COALESCE((SELECT SUM(amount_cents) FROM payments py WHERE py.parent_id=p.id AND py.annual_fee_id=y.id),0) paid_cents
 FROM parents p CROSS JOIN annual_fees y
 LEFT JOIN learners l ON l.parent_id=p.id
 LEFT JOIN family_annual_charges fc ON fc.parent_id=p.id AND fc.annual_fee_id=y.id
 WHERE y.id=? AND (?='' OR lower(p.parent_code||' '||p.name||' '||p.phone||' '||COALESCE(p.email,'')) LIKE lower('%'||?||'%'))
 GROUP BY p.id ORDER BY p.name`).all(y.id,q,q);
 res.json(rows.map(x=>({...x,balance_cents:x.charged_cents-x.paid_cents})));
});
app.post("/api/parents",auth,(req,res)=>{
 const {name,phone,email,notes}=req.body;if(!name||!phone)return res.status(400).json({error:"Name and phone are required"});
 const next=db.prepare("SELECT COALESCE(MAX(id),0)+1 n FROM parents").get().n;
 const parentCode="P"+String(next).padStart(3,"0");
 const r=db.prepare("INSERT INTO parents(parent_code,name,phone,email,notes) VALUES(?,?,?,?,?)").run(parentCode,name,phone,email||null,notes||null);
 res.json({id:r.lastInsertRowid,parentCode});
});
app.put("/api/parents/:id",auth,(req,res)=>{
 const {name,phone,email,notes}=req.body;if(!name||!phone)return res.status(400).json({error:"Name and phone are required"});
 db.prepare("UPDATE parents SET name=?,phone=?,email=?,notes=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(name,phone,email||null,notes||null,req.params.id);res.json({ok:true});
});
app.get("/api/parents/:id",auth,(req,res)=>{
 const y=activeYear(),p=db.prepare("SELECT * FROM parents WHERE id=?").get(req.params.id);
 if(!p)return res.status(404).json({error:"Parent not found"});
 const learners=db.prepare("SELECT * FROM learners WHERE parent_id=? ORDER BY name").all(p.id);
 const charge=db.prepare("SELECT amount_cents FROM family_annual_charges WHERE parent_id=? AND annual_fee_id=?").get(p.id,y.id);
 const charged=charge?.amount_cents??y.standard_fee_cents;
 const payments=db.prepare("SELECT py.*,s.full_name recorded_by_name FROM payments py JOIN staff_profiles s ON s.id=py.recorded_by WHERE py.parent_id=? ORDER BY py.payment_date DESC,py.id DESC").all(p.id);
 const yearPayments=payments.filter(x=>x.annual_fee_id===y.id);
 const paid=yearPayments.reduce((a,x)=>a+x.amount_cents,0);
 res.json({...p,learners,year:y,charged_cents:charged,paid_cents:paid,balance_cents:charged-paid,payments});
});
app.put("/api/parents/:id/charge",auth,admin,(req,res)=>{
 const y=activeYear(),{amountCents}=req.body;
 if(!Number.isInteger(amountCents)||amountCents<0)return res.status(400).json({error:"Invalid amount"});
 db.prepare(`INSERT INTO family_annual_charges(parent_id,annual_fee_id,amount_cents) VALUES(?,?,?)
 ON CONFLICT(parent_id,annual_fee_id) DO UPDATE SET amount_cents=excluded.amount_cents`).run(req.params.id,y.id,amountCents);
 res.json({ok:true});
});

app.post("/api/learners",auth,(req,res)=>{
 const {parentId,name,grade}=req.body;if(!parentId||!name||!grade)return res.status(400).json({error:"All learner fields are required"});
 const r=db.prepare("INSERT INTO learners(parent_id,name,grade) VALUES(?,?,?)").run(parentId,name,grade);res.json({id:r.lastInsertRowid});
});
app.put("/api/learners/:id",auth,(req,res)=>{
 const {parentId,name,grade}=req.body;if(!parentId||!name||!grade)return res.status(400).json({error:"All learner fields are required"});
 db.prepare("UPDATE learners SET parent_id=?,name=?,grade=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(parentId,name,grade,req.params.id);res.json({ok:true});
});

app.get("/api/dashboard",auth,(req,res)=>{
 const y=activeYear();
 const totals=db.prepare(`SELECT COALESCE(SUM(COALESCE(fc.amount_cents,y.standard_fee_cents)),0) expected,
 COALESCE((SELECT SUM(amount_cents) FROM payments WHERE annual_fee_id=y.id),0) collected,
 COUNT(p.id) families
 FROM parents p CROSS JOIN annual_fees y LEFT JOIN family_annual_charges fc ON fc.parent_id=p.id AND fc.annual_fee_id=y.id WHERE y.id=?`).get(y.id);
 const fully=db.prepare(`SELECT COUNT(*) n FROM (
 SELECT p.id,COALESCE(fc.amount_cents,y.standard_fee_cents) charged,
 COALESCE((SELECT SUM(amount_cents) FROM payments WHERE parent_id=p.id AND annual_fee_id=y.id),0) paid
 FROM parents p CROSS JOIN annual_fees y LEFT JOIN family_annual_charges fc ON fc.parent_id=p.id AND fc.annual_fee_id=y.id WHERE y.id=?) x WHERE paid>=charged`).get(y.id).n;
 const outstanding=db.prepare(`SELECT p.id,p.name,p.phone,COUNT(DISTINCT l.id) children_count,
 COALESCE(fc.amount_cents,y.standard_fee_cents) charged_cents,
 COALESCE((SELECT SUM(amount_cents) FROM payments WHERE parent_id=p.id AND annual_fee_id=y.id),0) paid_cents
 FROM parents p CROSS JOIN annual_fees y LEFT JOIN family_annual_charges fc ON fc.parent_id=p.id AND fc.annual_fee_id=y.id LEFT JOIN learners l ON l.parent_id=p.id
 WHERE y.id=? GROUP BY p.id HAVING charged_cents>paid_cents ORDER BY (charged_cents-paid_cents) DESC`).all(y.id).map(x=>({...x,balance_cents:x.charged_cents-x.paid_cents}));
 const recent=db.prepare(`SELECT py.id,py.receipt_no,py.payment_date,py.amount_cents,py.method,p.name parent_name,y.year
 FROM payments py JOIN parents p ON p.id=py.parent_id JOIN annual_fees y ON y.id=py.annual_fee_id ORDER BY py.id DESC LIMIT 10`).all();
 res.json({year:y,...totals,fully_paid:fully,outstanding,recent,outstanding_cents:totals.expected-totals.collected});
});

app.get("/api/payments",auth,(req,res)=>{
 let {q="",from="",to="",method="",year=""}=req.query;
 const rows=db.prepare(`SELECT py.*,p.name parent_name,y.year annual_year,s.full_name recorded_by_name
 FROM payments py JOIN parents p ON p.id=py.parent_id JOIN annual_fees y ON y.id=py.annual_fee_id JOIN staff_profiles s ON s.id=py.recorded_by
 WHERE (?='' OR lower(p.name||' '||py.reference||' '||py.receipt_no) LIKE lower('%'||?||'%'))
 AND (?='' OR py.payment_date>=?) AND (?='' OR py.payment_date<=?) AND (?='' OR py.method=?)
 AND (?='' OR y.year=?)
 ORDER BY py.payment_date DESC,py.id DESC`).all(q,q,from,from,to,to,method,method,year,year);
 res.json(rows);
});

app.post("/api/payments",auth,(req,res)=>{
 const {parentId,amountCents,paymentDate,method,reference,note}=req.body;
 if(!parentId||!Number.isInteger(amountCents)||amountCents<=0||!paymentDate||!validMethods.has(method)||!reference)return res.status(400).json({error:"Invalid payment details"});
 const y=activeYear(),parent=db.prepare("SELECT * FROM parents WHERE id=?").get(parentId);if(!parent)return res.status(404).json({error:"Parent not found"});
 const existingCharge=db.prepare("SELECT amount_cents FROM family_annual_charges WHERE parent_id=? AND annual_fee_id=?").get(parentId,y.id);
 const charged=existingCharge?.amount_cents??y.standard_fee_cents;
 const paid=db.prepare("SELECT COALESCE(SUM(amount_cents),0) n FROM payments WHERE parent_id=? AND annual_fee_id=?").get(parentId,y.id).n;
 const receipt=db.prepare("SELECT COALESCE(MAX(receipt_no),999)+1 n FROM payments").get().n;
 const tx=db.transaction(()=>db.prepare(`INSERT INTO payments(parent_id,annual_fee_id,amount_cents,payment_date,method,reference,note,receipt_no,recorded_by)
 VALUES(?,?,?,?,?,?,?,?,?)`).run(parentId,y.id,amountCents,paymentDate,method,reference,note||null,receipt,req.session.staffId));
 const id=tx();res.json({id,receiptNo:receipt,overpayment:amountCents>Math.max(0,charged-paid)});
});

app.get("/api/receipts/:id",auth,(req,res)=>{
 const x=db.prepare(`SELECT py.*,p.parent_code,p.name parent_name,p.phone,p.email,y.year annual_year,y.standard_fee_cents,s.full_name recorded_by_name
 FROM payments py JOIN parents p ON p.id=py.parent_id JOIN annual_fees y ON y.id=py.annual_fee_id JOIN staff_profiles s ON s.id=py.recorded_by WHERE py.id=?`).get(req.params.id);
 if(!x)return res.status(404).json({error:"Receipt not found"});
 const learners=db.prepare("SELECT name,grade FROM learners WHERE parent_id=? ORDER BY name").all(x.parent_id);
 const charge=db.prepare("SELECT amount_cents FROM family_annual_charges WHERE parent_id=? AND annual_fee_id=?").get(x.parent_id,x.annual_fee_id);
 const charged=charge?.amount_cents??x.standard_fee_cents;
 const paid=db.prepare("SELECT COALESCE(SUM(amount_cents),0) n FROM payments WHERE parent_id=? AND annual_fee_id=?").get(x.parent_id,x.annual_fee_id).n;
 res.json({...x,learners,charged_cents:charged,paid_cents:paid,balance_cents:charged-paid,school_name:SCHOOL_NAME});
});

app.get("/api/staff",auth,admin,(req,res)=>res.json(db.prepare("SELECT s.id,s.email,s.full_name fullName,r.role FROM staff_profiles s JOIN user_roles r ON r.staff_id=s.id ORDER BY s.id").all()));
app.post("/api/staff",auth,admin,(req,res)=>{
 const {email,password,fullName,role="staff"}=req.body;
 if(!email||!password||!fullName||!["admin","staff"].includes(role))return res.status(400).json({error:"Invalid staff details"});
 try{const tx=db.transaction(()=>{const r=db.prepare("INSERT INTO staff_profiles(email,password_hash,full_name) VALUES(?,?,?)").run(email,bcrypt.hashSync(password,12),fullName);db.prepare("INSERT INTO user_roles(staff_id,role) VALUES(?,?)").run(r.lastInsertRowid,role)});tx();res.json({ok:true})}
 catch(e){res.status(400).json({error:"Email already exists"})}
});

app.use(express.static(path.join(__dirname,"public")));
app.get("/{*splat}",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));

function csvEscape(v){ if(v===null||v===undefined)return ""; return '"'+String(v).replace(/"/g,'""')+'"'; }
function sendCsv(res,filename,headers,rows){
  const body=[headers,...rows].map(r=>r.map(csvEscape).join(",")).join("\r\n");
  res.setHeader("Content-Type","text/csv; charset=utf-8");
  res.setHeader("Content-Disposition",`attachment; filename="${filename}"`);
  res.send("\uFEFF"+body);
}
app.get("/api/export/parents",auth,(req,res)=>{
  const af=db.prepare("SELECT * FROM annual_fees WHERE active=1 LIMIT 1").get();
  const parents=db.prepare("SELECT * FROM parents ORDER BY id").all();
  const rows=parents.map(p=>{
    let charge=af?af.standard_fee_cents:0,paid=0;
    if(af){
      const c=db.prepare("SELECT amount_cents FROM family_annual_charges WHERE parent_id=? AND annual_fee_id=?").get(p.id,af.id);
      if(c)charge=c.amount_cents;
      paid=db.prepare("SELECT COALESCE(SUM(amount_cents),0) total FROM payments WHERE parent_id=? AND annual_fee_id=?").get(p.id,af.id).total;
    }
    const learners=db.prepare("SELECT name FROM learners WHERE parent_id=? ORDER BY id").all(p.id).map(x=>x.name).join(", ");
    return [p.parent_code,p.name,p.phone,p.email||"",learners,af?af.year:"",(charge/100).toFixed(2),(paid/100).toFixed(2),((charge-paid)/100).toFixed(2)];
  });
  sendCsv(res,`KWIHOTA-SCHOOL-parents-${af?af.year:"all"}.csv`,["Parent ID","Parent Name","Phone","Email","Learners","Year","Annual Fee (KSh)","Paid (KSh)","Balance (KSh)"],rows);
});
app.get("/api/export/payments",auth,(req,res)=>{
  const rows=db.prepare(`SELECT pay.receipt_no,p.parent_code,p.name parent_name,p.phone,COALESCE((SELECT GROUP_CONCAT(l.name, ', ') FROM learners l WHERE l.parent_id=p.id),'') learners,pay.amount_cents,pay.payment_date,pay.method,pay.reference,COALESCE(pay.note,'') note,af.year,COALESCE(s.email,'') recorded_by FROM payments pay JOIN parents p ON p.id=pay.parent_id JOIN annual_fees af ON af.id=pay.annual_fee_id LEFT JOIN staff_profiles s ON s.id=pay.recorded_by ORDER BY pay.payment_date DESC,pay.id DESC`).all();
  sendCsv(res,"KWIHOTA-SCHOOL-payment-history.csv",["Receipt No","Parent ID","Parent Name","Phone","Learners","Amount (KSh)","Date","Method","Reference","Note","Year","Recorded By"],rows.map(x=>[x.receipt_no,x.parent_code,x.parent_name,x.phone,x.learners,(x.amount_cents/100).toFixed(2),x.payment_date,x.method,x.reference,x.note,x.year,x.recorded_by]));
});
app.get("/api/export/outstanding",auth,(req,res)=>{
  const af=db.prepare("SELECT * FROM annual_fees WHERE active=1 LIMIT 1").get();
  if(!af)return sendCsv(res,"KWIHOTA-SCHOOL-outstanding.csv",["Parent ID","Parent Name","Phone","Annual Fee (KSh)","Paid (KSh)","Balance (KSh)"],[]);
  const rows=db.prepare(`SELECT p.parent_code,p.name,p.phone,COALESCE(c.amount_cents,af.standard_fee_cents) charge,COALESCE((SELECT SUM(amount_cents) FROM payments py WHERE py.parent_id=p.id AND py.annual_fee_id=af.id),0) paid FROM parents p LEFT JOIN family_annual_charges c ON c.parent_id=p.id AND c.annual_fee_id=af.id CROSS JOIN annual_fees af WHERE af.id=?`).all(af.id).filter(x=>x.charge-x.paid>0).sort((a,b)=>(b.charge-b.paid)-(a.charge-a.paid));
  sendCsv(res,`KWIHOTA-SCHOOL-outstanding-${af.year}.csv`,["Parent ID","Parent Name","Phone","Annual Fee (KSh)","Paid (KSh)","Balance (KSh)"],rows.map(x=>[x.parent_code,x.name,x.phone,(x.charge/100).toFixed(2),(x.paid/100).toFixed(2),((x.charge-x.paid)/100).toFixed(2)]));
});
app.get("/api/export/paid",auth,(req,res)=>{
  const af=db.prepare("SELECT * FROM annual_fees WHERE active=1 LIMIT 1").get();
  if(!af)return sendCsv(res,"KWIHOTA-SCHOOL-paid.csv",["Parent ID","Parent Name","Phone","Annual Fee (KSh)","Paid (KSh)","Balance (KSh)"],[]);
  const rows=db.prepare(`SELECT p.parent_code,p.name,p.phone,COALESCE(c.amount_cents,af.standard_fee_cents) charge,COALESCE((SELECT SUM(amount_cents) FROM payments py WHERE py.parent_id=p.id AND py.annual_fee_id=af.id),0) paid FROM parents p LEFT JOIN family_annual_charges c ON c.parent_id=p.id AND c.annual_fee_id=af.id CROSS JOIN annual_fees af WHERE af.id=?`).all(af.id).filter(x=>x.charge-x.paid<=0);
  sendCsv(res,`KWIHOTA-SCHOOL-fully-paid-${af.year}.csv`,["Parent ID","Parent Name","Phone","Annual Fee (KSh)","Paid (KSh)","Balance (KSh)"],rows.map(x=>[x.parent_code,x.name,x.phone,(x.charge/100).toFixed(2),(x.paid/100).toFixed(2),((x.charge-x.paid)/100).toFixed(2)]));
});

app.listen(PORT,()=>console.log(`School Fee Management running on http://localhost:${PORT}`));
}
main().catch(err=>{console.error(err);process.exit(1)});
