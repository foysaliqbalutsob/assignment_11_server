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
    req.decodedEmail = decoded.email; 
    console.log("Decoded email:", decoded.email);
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
    const userCollection = myDB.collection("AssetUsers");
    const assetCollection = myDB.collection("assets");

    const paymentCollection = myDB.collection("paymentCollection");
    const packageCollection = myDB.collection("packages");

    // middleware to verify admin
    const verifyAdmin = async (req, res, next) => {
      try {
        const email = req.decodedEmail;
        // console.log("from verify:", email);

        if (!email) {
          return res.status(403).send({ message: "Forbidden Access" });
        }

        const user = await userCollection.findOne({ email });
        console.log(user.role);

        if (!user || user.role !== "hr") {
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
    app.get("/users", verifyToken, async (req, res) => {
      const searchText = req.query.searchText || "";
      const query = {};

      if (searchText) {
        // case-insensitive partial match on name or email
        query.$or = [
          { displayName: { $regex: searchText, $options: "i" } },
          { email: { $regex: searchText, $options: "i" } },
        ];
      }

      const cursor = userCollection
        .find(query)
        .sort({ createdAt: -1 })
        .limit(5);
      const result = await cursor.toArray();
      res.send(result);
    });

    //for useUserRole ok
    app.get("/users/:email", async (req, res) => {
      const email = req.params.email;
      const user = await userCollection.findOne({ email });
      res.send(user || {});
    });

    app.get("/users/:email/role", async (req, res) => {
      const email = req.params.email;
      const query = { email };
      const user = await userCollection.findOne(query);
      res.send({ role: user?.role || "user" });
    });

    // post user
    app.post("/users", async (req, res) => {
      const user = req.body;

      user.createdAt = new Date();

      const userExist = await userCollection.findOne({ email: user.email });
      if (userExist) {
        return res.send({ message: "User already exist" });
      }

      const result = await userCollection.insertOne(user);
      res.send(result);
    });

    // update user
    app.patch("/users/:id/role", verifyToken, verifyAdmin, async (req, res) => {
      const id = req.params.id;
      console.log(id);

      const roleInfo = req.body;

      const query = { _id: new ObjectId(id) };

      const updateDoc = {
        $set: { role: roleInfo.role },
      };
      const result = await userCollection.updateOne(query, updateDoc, {
        upsert: true,
      });
      res.send(result);
    });

    // Asset related apis
    app.get("/assets", async (req, res) => {
      const cursor = myDB.collection("assets").find({});
      const result = await cursor.toArray();
      res.send(result);
    });

    app.post("/assets", verifyToken, async (req, res) => {
      const asset = req.body;
      asset.createdAt = new Date();
      const result = await assetCollection.insertOne(asset);
      res.send(result);
    });
    

    // apis call by user email
// get by email
//    app.get("/assets", verifyToken, async (req, res) => {
//   const { hrEmail } = req.query;

//   let query = {};
//   if (hrEmail) {
//     query.hrEmail = hrEmail;
//   }

//   const result = await assetCollection.find(query).toArray();
//   res.send(result);
// });


// --- Assets API ---

app.get("/assetsEmail", verifyToken, async (req, res) => {
  try {
    const email = req.decodedEmail; 
    console.log("Fetching assets for:", email);

    if (!email) {
      return res.status(401).send({ message: "Unauthorized" });
    }

    const query = { hrEmail: email }; 
    const assets = await assetCollection.find(query).toArray();

    res.send(assets);
  } catch (error) {
    console.error("Error fetching assets:", error);
    res.status(500).send({ message: "Server Error" });
  }
});













    // delete asset
    app.delete("/assets/:id", verifyToken, async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await assetCollection.deleteOne(query);
      res.send(result);
    });

    // update asset
    app.patch("/assets/:id", verifyToken, async (req, res) => {
      const id = req.params.id;
      const assetInfo = req.body;
      const query = { _id: new ObjectId(id) };

      const updateDoc = {
        $set: {
          name: assetInfo.name,
          type: assetInfo.type,
          value: assetInfo.value,
          location: assetInfo.location,
          status: assetInfo.status,
        },
      };
      const result = await assetCollection.updateOne(query, updateDoc, {
        upsert: true,
      });
      res.send(result);
    });

    // packages related apis

    app.get("/packages", async (req, res) => {
      const cursor = packageCollection.find({});
      const result = await cursor.toArray();
      res.send(result);
    });

    // payment related APIS

    app.get("/payments", verifyToken, async (req, res) => {
      const email = req.query.email;
      if (req.decodedEmail !== email) {
        return res.status(401).send({ error: "Forbidden" });
      }
      const result = await paymentCollection
        .find({ hrEmail: email })
        .sort({ paymentDate: -1 })
        .toArray();
      res.send(result);
    });

    app.post("/payment-create-checkout-session", async (req, res) => {
      try {
        const paymentInfo = req.body;

        const amount = parseInt(paymentInfo.cost) * 100;

        // Create Stripe session
        const session = await stripe.checkout.sessions.create({
          payment_method_types: ["card"],
          line_items: [
            {
              price_data: {
                currency: "usd",
                product_data: { name: paymentInfo.packageName },
                unit_amount: amount,
              },
              quantity: 1,
            },
          ],
          mode: "payment",
          customer_email: paymentInfo.email,
          metadata: {
            packageId: paymentInfo.packageId,
            packageName: paymentInfo.packageName,
            hrEmail: paymentInfo.email,
          },
          success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancel`,
        });
        console.log(paymentInfo.packageName, paymentInfo.packageId);

        // Save payment record as pending
        await paymentCollection.insertOne({
          hrEmail: paymentInfo.email,
          packageId: paymentInfo.packageId,
          packageName: paymentInfo.packageName,
          employeeLimit: paymentInfo.employeeLimit || 0,
          amount: paymentInfo.cost,
          transactionId: null,
          paymentDate: new Date(),
          status: "pending",
          stripeSessionId: session.id,
        });

        res.json({ url: session.url });
      } catch (err) {
        console.error("Stripe session error:", err);
        res.status(500).json({ error: "Server error creating Stripe session" });
      }
    });

    // check out session

    // payment success verify

    // PATCH payment-success
    // ----- Update Payment Status -----

    app.patch("/payment-success", verifyToken, async (req, res) => {
      const sessionId = req.query.session_id;

      if (!sessionId) {
        return res.status(400).send({ message: "session_id missing" });
      }

      try {
        const session = await stripe.checkout.sessions.retrieve(sessionId);

        if (session.payment_status !== "paid") {
          return res.status(400).send({ message: "Payment not completed" });
        }

        const updateResult = await paymentCollection.updateOne(
          {
            stripeSessionId: sessionId,
            status: "pending", // 🔐 lock
          },
          {
            $set: {
              trackingId: generateTrackingId(),
              transactionId: session.payment_intent,
              status: "paid",
              paymentDate: new Date(),
            },
          }
        );

        if (updateResult.modifiedCount === 0) {
          const existingPayment = await paymentCollection.findOne({
            stripeSessionId: sessionId,
          });

          return res.send({
            success: true,
            message: "Payment already processed",
            paymentInfo: existingPayment,
          });
        }

        const payment = await paymentCollection.findOne({
          stripeSessionId: sessionId,
        });

        await userCollection.updateOne(
          { email: payment.hrEmail },
          {
            $inc: { packageLimit: payment.employeeLimit },
            $set: { subscription: payment.packageName },
          }
        );

        res.send({
          success: true,
          message: "Payment processed successfully",
          paymentInfo: payment,
        });
      } catch (error) {
        console.error("Payment success error:", error);
        res.status(500).send({ message: "Server error" });
      }
    });

    // payment related apis
    // app.get("/payments", verifyToken, async (req, res) => {
    //   const email = req.query.email;
    //   if (req.decodedEmail !== email) {
    //     return res.status(401).send({ error: "Forbidden" });
    //   }

    //   const result = await paymentCollection
    //     .find({ customerEmail: email })
    //     .sort({ createdAt: -1 })
    //     .toArray()

    //   res.send(result);
    // });
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
