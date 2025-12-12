const express = require("express");
const cors = require("cors");
const app = express();
require("dotenv").config();
const port = process.env.PORT || 3000;
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const stripe = require("stripe")(process.env.STRIPE_SECRET);

const admin = require("firebase-admin");
const serviceAccount = require("./serviceAccountKey.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// middleware
app.use(express.json());
app.use(cors());

async function verifyToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).send({ error: "Unauthorized" });
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.decodedEmail = decoded.email; // store decoded email
    next();
  } catch (error) {
    console.error("Token verify error:", error);
    return res.status(401).send({ error: "Invalid token" });
  }
}



function generateTrackingId() {
  const random = Math.random().toString(36).substring(2, 10).toUpperCase();
  const year = new Date().getFullYear();
  return `ZIS-${year}-${random}`;
}

// MongoDB
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.um9bwdr.mongodb.net/?appName=Cluster0`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    await client.connect();
    await client.db("admin").command({ ping: 1 });
    console.log("Pinged your deployment. Connected to MongoDB!");

    // --- Database & Collection ---
    const myDB = client.db("zap_shift_db");
    const userCollection = myDB.collection('AssetUsers');
    // const parcelColl = myDB.collection("parcels");
    const paymentCollection = myDB.collection("payments");
    // const ridersCollection = myDB.collection("riders");


    // middleware to verify admin 
    const verifyAdmin = async (req, res, next) => {
  try {
    const email = req.decodedEmail;
    console.log(email)

    if (!email) {
      return res.status(403).send({ message: "Forbidden Access" });
    }

    const user = await userCollection.findOne({ email });

    if (!user || user.role !== "admin") {
      return res.status(403).send({ message: "Forbidden Access" });
    }

    next();

  } catch (err) {
    console.error(err);
    return res.status(500).send({ message: "Server Error" });
  }
};

    



// users related api

// get user
app.get('/users', verifyToken,async(req, res) =>{
  const searchText = req.query.searchText || "";
  const query = {};

  if (searchText) {
    // case-insensitive partial match on name or email
    query.$or = [
      { displayName: { $regex: searchText, $options: "i" } },
      { email: { $regex: searchText, $options: "i" } }
    ];
  }


  const cursor = userCollection.find(query).sort({ createdAt : -1}).limit(5);
  const result = await cursor.toArray();
  res.send(result);

}) 


app.get('/users/:id', async(req,res)=>{

});


app.get('/users/:email/role', async(req, res) =>{
  const email = req.params.email;
  const query = {email}
  const user = await userCollection.findOne(query);
  res.send({ role: user ?.role || 'user'});



});









// post user
app.post('/users', async(req, res) =>{
  const user =req.body;
   
   user.createdAt = new Date();

   const userExist = await userCollection.findOne({email: user.email});
   if(userExist){
    return res.send({message: 'User already exist'})
   } 



   const result = await userCollection.insertOne(user);
   res.send(result)
});

// update user
app.patch('/users/:id/role', verifyToken,verifyAdmin, async(req, res) =>{
  const id = req.params.id
  console.log(id)
 
  const roleInfo = req.body;

  const query = { _id: new ObjectId(id)}

  
  const updateDoc = {
    $set: { role: roleInfo.role } 
  };  
  const result = await userCollection.updateOne(query, updateDoc, {upsert: true});
  res.send(result);
}
);










 









 




;

    // payment related APIS

    // new

    app.post("/payment-create-checkout-session", async (req, res) => {
      const paymentInfo = req.body;
      const amount = parseInt(paymentInfo.cost) * 100;

      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            price_data: {
              currency: "usd",
              product_data: {
                name: `please pay for ${paymentInfo.parcelName}`,
              },
              unit_amount: amount,
            },
            quantity: 1,
          },
        ],
        mode: "payment",
        metadata: {
          parcelId: paymentInfo.parcelId,
        },
        customer_email: paymentInfo.senderEmail,
        success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancel`,
      });

      await parcelColl.updateOne(
        { _id: new ObjectId(paymentInfo.parcelId) },
        { $set: { checkoutSessionId: session.id } }
      );

      res.send({ url: session.url });
    });

    // check out session

    // payment success verify

    // PATCH payment-success
    // ----- Update Payment Status -----

    app.patch("/payment-success", async (req, res) => {
      const sessionId = req.query.session_id;
      if (!sessionId) {
        return res.status(400).json({ error: "session_id missing" });
      }

      try {
        const session = await stripe.checkout.sessions.retrieve(sessionId);

        if (session.payment_status !== "paid") {
          return res.status(400).json({ error: "Payment not completed" });
        }

        const alreadyPaid = await paymentCollection.findOne({ sessionId });
        if (alreadyPaid) {
          return res.json({
            message: "Payment already processed",
            paymentInfo: {
              trackingId: alreadyPaid.trackingId,
              transactionId: alreadyPaid.transactionId,
            },
          });
        }

        const trackingId = generateTrackingId();
        const transactionId = session.payment_intent;

        // Save payment
        await paymentCollection.insertOne({
          sessionId,
          parcelId: session.metadata.parcelId,
          transactionId,
          amount: session.amount_total,
          status: "paid",
          customerEmail: session.customer_email,
          trackingId,
          createdAt: new Date(),
        });

        
        const updated = await parcelColl.updateOne(
          { checkoutSessionId: sessionId },
          {
            $set: {
              paymentStatus: "paid",
              deliveryStatus: "pending-peakUp",
              transactionId,
              trackingId,
            },
          }
        );

        if (updated.modifiedCount === 0) {
          return res.status(404).json({ error: "Parcel not found to update" });
        }

        // Return expected response
        res.json({
          message: "Payment updated successfully",
          paymentInfo: {
            trackingId,
            transactionId,
          },
        });
      } catch (error) {
        console.log("Payment update error:", error);
        res.status(500).json({ error: "Server error" });
      }
    });

    // payment related apis
    app.get("/payments", verifyToken, async (req, res) => {
      const email = req.query.email;
      if (req.decodedEmail !== email) {
        return res.status(401).send({ error: "Forbidden" });
      }

      const result = await paymentCollection
        .find({ customerEmail: email })
        .sort({ createdAt: -1 })
        .toArray()
        
      res.send(result);
    });




    













   

   
  } finally {
    // do not close client
  }
}
run().catch(console.dir);

// default route
app.get("/", (req, res) => {
  res.send("Zap is shifting shifting!");
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
