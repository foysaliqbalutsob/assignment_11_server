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
    // console.log("Decoded email:", decoded.email);
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
    const requestCollection = myDB.collection("requests");

    const assignedAssetsCollection = myDB.collection("assignedAssets");

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
        console.log("Admin verified", user.role);
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

    // for profile patch

    // Update user info
    app.patch("/users/:email", verifyToken, async (req, res) => {
      const email = req.params.email;
      const updatedInfo = req.body;
      try {
        const result = await userCollection.updateOne(
          { email },
          { $set: updatedInfo }
        );

        if (result.matchedCount === 0) {
          return res.status(404).send({ message: "User not found" });
        }

        res.send({ success: true, message: "User updated successfully" });
      } catch (err) {
        console.error("User update error:", err);
        res.status(500).send({ message: "Server error updating user" });
      }
    });

    //for useUserRole ok
    app.get("/users/:email", async (req, res) => {
      const email = req.params.email;
      const user = await userCollection.findOne({ email });
      res.send(user || {});
    });

    // for employee role

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

    // Asset related apis
    // app.get("/assets", async (req, res) => {
    //   const cursor = myDB.collection("assets").find({});
    //   const result = await cursor.toArray();
    //   res.send(result);
    // });

    app.get("/assets", async (req, res) => {
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 10;

      const skip = (page - 1) * limit;

      const total = await assetCollection.countDocuments();

      const assets = await assetCollection
        .find({})
        .skip(skip)
        .limit(limit)
        .toArray();

      res.send({
        assets,
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      });
    });

    app.post("/assets", verifyToken, async (req, res) => {
      const asset = req.body;
      asset.createdAt = new Date();
      const result = await assetCollection.insertOne(asset);
      res.send(result);
    });

    // --- Assets API ---

    app.get("/assetsEmail", verifyToken, verifyAdmin, async (req, res) => {
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
          productName: assetInfo.productName,
          productImage: assetInfo.productImage,
          productQuantity: Number(assetInfo.productQuantity),
          availableQuantity: Number(assetInfo.availableQuantity),
          productType: assetInfo.productType,
          companyName: assetInfo.companyName,
        },
      };

      const result = await assetCollection.updateOne(query, updateDoc);

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
        // console.log(paymentInfo.packageName, paymentInfo.packageId);

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
            status: "pending",
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

    // Request related APIs

    // get by hr email

    app.get(
      "/asset-requests/by-hr",
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        const hrEmail = req.decodedEmail;
        // console.log("Fetching requests dddgh for HR:", hrEmail);

        const result = await requestCollection
          .find({ hrEmail })
          .sort({ requestDate: -1 })

          .toArray();

        res.send(result);
      }
    );

    // post request
    app.post("/asset-requests", verifyToken, async (req, res) => {
      const request = req.body;

      const exists = await requestCollection.findOne({
        assetId: new ObjectId(request.assetId),
        requesterEmail: req.decodedEmail,
        requestStatus: { $in: ["pending", "approved"] },
      });

      if (exists) {
        return res.status(400).send({ message: "Already requested" });
      }

      const newRequest = {
        assetId: new ObjectId(request.assetId),
        assetName: request.assetName,
        assetImage: request.assetImage,
        assetType: request.assetType,
        requesterName: request.requesterName,
        requesterEmail: req.decodedEmail,
        hrEmail: request.hrEmail,
        companyName: request.companyName,
        requestDate: new Date(),
        approvalDate: null,
        requestStatus: "pending",

        productQuantity: Number(request.productQuantity),
        availableQuantity: Number(request.availableQuantity),
        requesterBirthOfDate: request.requesterBirthOfDate,

        note: request.note,
        processedBy: null,
      };

      const result = await requestCollection.insertOne(newRequest);
      res.send(result);
    });

    app.patch(
      "/asset-requests/:id/approve",
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const requestId = req.params.id;
          const hrEmail = req.decodedEmail;

          const request = await requestCollection.findOne({
            _id: new ObjectId(requestId),
          });
          console.log(request);

          if (!request) {
            return res.status(404).send({ message: "Request not found" });
          }

          if (request.requestStatus !== "pending") {
            return res.status(400).send({ message: "Already processed" });
          }

          const asset = await assetCollection.findOne({
            _id: new ObjectId(request.assetId),
          });

          if (!asset) {
            return res.status(404).send({ message: "Asset not found" });
          }

          if (asset.productQuantity < 1) {
            return res.status(400).send({ message: "Out of stock" });
          }

          await requestCollection.updateOne(
            { _id: new ObjectId(requestId) },
            {
              $set: {
                requestStatus: "approved",
                approvalDate: new Date(),
                processedBy: hrEmail,
                productQuantity: "",
                availableQuantity: "",
                employeeBateOfBirth: "",

                returnDeadline:
                  request.assetType === "Returnable"
                    ? new Date(Date.now())
                    : null,
              },
            }
          );

          await assetCollection.updateOne(
            { _id: asset._id },
            { $inc: { availableQuantity: -1 } }
          );

          await assignedAssetsCollection.insertOne({
            assetId: asset._id,
            assetName: asset.productName,
            assetImage: asset.productImage,
            assetType: asset.productType,
            employeeEmail: request.requesterEmail,
            employeeName: request.requesterName,
            hrEmail,
            productQuantity: asset.productQuantity,
            availableQuantity: asset.availableQuantity - 1,
            employeeDateOfBirth: request.requesterBirthOfDate,
            companyName: request.companyName,
            assignmentDate: new Date(),
            returnDate: null,
            status: "assigned",
          });

          // userCollection edit

          const hrUser = await userCollection.findOne({ email: hrEmail });

          if (!hrUser) {
            return res.status(404).send({ message: "HR not found" });
          }

          if (hrUser.packageLimit <= 0) {
            return res.status(403).send({
              message: "Package limit exceeded. Please upgrade package.",
            });
          }

          await userCollection.updateOne(
            { email: hrEmail },

            {
              $inc: {
                currentEmployees: 1,
                packageLimit: -1,
              },
            }
          );

          res.send({ success: true });
        } catch (error) {
          console.error("APPROVE ERROR ", error);
          res.status(500).send({ message: "Internal Server Error" });
        }
      }
    );

    // return asset request

    // return asset (employee)
    app.patch("/asset-requests/:id/return", verifyToken, async (req, res) => {
      try {
        const id = req.params.id;
        const email = req.decodedEmail;

        const request = await requestCollection.findOne({
          _id: new ObjectId(id),
          requesterEmail: email,
          requestStatus: "approved",
          assetType: "Returnable",
        });

        if (!request) {
          return res.status(400).send({ message: "Not returnable" });
        }

        // update request status
        await requestCollection.updateOne(
          { _id: request._id },
          {
            $set: {
              requestStatus: "returned",
              returnDate: new Date(),
            },
          }
        );

        // increase asset quantity
        await assetCollection.updateOne(
          { _id: new ObjectId(request.assetId) },
          { $inc: { availableQuantity: 1 } }
        );

        res.send({ success: true });
      } catch (err) {
        console.error("RETURN ERROR:", err);
        res.status(500).send({ message: "Server error" });
      }
    });

    // reject asset request
    app.patch(
      "/asset-requests/:id/reject",
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const id = req.params.id;
          const hrEmail = req.decodedEmail;

          console.log("hrEmail", hrEmail);

          const request = await requestCollection.findOne({
            _id: new ObjectId(id),
            hrEmail,
          });

          if (!request) {
            return res.status(404).send({ message: "Request not found" });
          }

          if (request.requestStatus !== "pending") {
            return res
              .status(400)
              .send({ message: "Request already processed" });
          }

          const result = await requestCollection.updateOne(
            { _id: new ObjectId(id) },
            {
              $set: {
                requestStatus: "rejected",
                approvalDate: new Date(),
                processedBy: hrEmail,
              },
            }
          );

          res.send({
            success: true,
            message: "Request rejected",
            result,
          });
        } catch (error) {
          console.error("Reject error:", error);
          res.status(500).send({ message: "Server error" });
        }
      }
    );

    // get all requests of a specific user
    app.get("/asset-requests/user/:email", verifyToken, async (req, res) => {
      try {
        const email = req.params.email;

        // make sure user can only fetch their own requests
        if (req.decodedEmail !== email) {
          return res.status(403).send({ message: "Forbidden" });
        }

        const requests = await requestCollection
          .find({ requesterEmail: email })
          .sort({ requestDate: -1 })
          .toArray();

        res.send(requests);
      } catch (err) {
        console.error(err);
        res.status(500).send({ message: "Server error" });
      }
    });

    // end of Request related APIs

    // for your employee list

    // HR sees all assigned assets under him
    app.get(
      "/assigned-assets/hr/:email",
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        const email = req.params.email;

        if (req.decodedEmail !== email) {
          return res.status(401).send({ error: "Forbidden" });
        }

        const result = await requestCollection
          .find({ hrEmail: email, requestStatus: "approved" })
          .sort({ approvalDate: -1 })
          .toArray();

        res.send(result);
      }
    );

    // find hr limit from user collection

    app.get("/users/hr", verifyToken, async (req, res) => {
      const email = req.query.email;

      if (!email) {
        return res
          .status(400)
          .send({ message: "Email query parameter is required" });
      }

      const user = await userCollection.findOne({ email });
      if (!user) return res.status(404).send({ message: "User not found" });

      res.send({ packageLimit: user.packageLimit || 0 });
    });

    // my team er kaaj

    // GET employee companies

    // GET employee companies (using find)
    app.get("/employee/companies/:email", verifyToken, async (req, res) => {
      const email = req.params.email;

      if (req.decodedEmail !== email) {
        return res.status(403).send({ message: "Forbidden" });
      }

      const result = await assignedAssetsCollection
        .find({ employeeEmail: email })
        .project({ companyName: 1, _id: 0 })
        .toArray();

      // unique company names
      const companies = [
        ...new Set(result.map((item) => item.companyName)),
      ].map((name) => ({ companyName: name }));

      res.send(companies);
    });

    // GET employees of a specific company
    app.get("/company/:companyName", verifyToken, async (req, res) => {
      const companyName = req.params.companyName;

      // find all assets of this company
      const assets = await assignedAssetsCollection
        .find({ companyName })
        .toArray();

      // create unique employees list
      const employeeMap = {};
      assets.forEach((asset) => {
        if (!employeeMap[asset.employeeEmail]) {
          employeeMap[asset.employeeEmail] = {
            name: asset.employeeName,
            email: asset.employeeEmail,
            photo: asset.assetImage || null,
            position: asset.position || "",
            dateOfBirth: asset.employeeDateOfBirth,
          };
        }
      });

      const employees = Object.values(employeeMap);
      console.log(employeeMap);

      res.send(employees);
    });

    // for bar rechart

    app.get(
      "/dashboard/asset-type-summary",
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        const hrEmail = req.decodedEmail;

        const pipeline = [
          { $match: { hrEmail } },
          {
            $group: {
              _id: "$assetType",
              count: { $sum: 1 },
            },
          },
        ];

        const result = await assignedAssetsCollection
          .aggregate(pipeline)
          .toArray();

        let summary = {
          returnable: 0,
          nonReturnable: 0,
        };

        result.forEach((item) => {
          if (item._id === "Returnable") {
            summary.returnable = item.count;
          } else {
            summary.nonReturnable += item.count;
          }
        });

        res.send(summary);
      }
    );

    // second

    app.get(
      "/dashboard/top-assets",
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        const hrEmail = req.decodedEmail;

        const pipeline = [
          { $match: { hrEmail } },
          {
            $group: {
              _id: "$assetName",
              count: { $sum: 1 },
            },
          },
          { $sort: { count: -1 } },
          { $limit: 5 },
        ];

        const result = await assignedAssetsCollection
          .aggregate(pipeline)
          .toArray();

        const formatted = result.map((item) => ({
          assetName: item._id,
          count: item.count,
        }));

        res.send(formatted);
      }
    );

    // end

    // hr can assign assetto affilated employee

    // app.post(
    //   "/assigned-assets",
    //   verifyToken,
    //   verifyAdmin,
    //   async (req, res) => {
    //     const data = req.body;
    //     const hrEmail = data.hrEmail;

    //     const asset = await assetCollection.findOne({
    //       _id: new ObjectId(data.assetId),
    //     });

    //     if (!asset || asset.availableQuantity <= 0) {
    //       return res.status(400).send({ message: "Asset not available" });
    //     }

    //     // Get HR user
    //     const hrUser = await userCollection.findOne({ email: hrEmail });
    //     if (!hrUser) {
    //       return res.status(404).send({ message: "HR user not found" });
    //     }

    //     if (hrUser.packageLimit <= 0) {
    //       return res
    //         .status(403)
    //         .send({ message: "Package limit exceeded. Upgrade package." });
    //     }

    //     // Insert assigned asset
    //     await assignedAssetsCollection.insertOne({
    //       ...data,
    //       assignmentDate: new Date(),
    //       returnDate: null,
    //       status: "assigned",
    //     });

    //     // Decrement asset available quantity
    //     await assetCollection.updateOne(
    //       { _id: asset._id },
    //       { $inc: { availableQuantity: -1 } }
    //     );

    //     // Update HR's packageLimit and currentEmployees
    //     await userCollection.updateOne(
    //       { email: hrEmail },
    //       { $inc: { packageLimit: -1, currentEmployees: 1 } }
    //     );

    //     res.send({ success: true, message: "Asset assigned and HR updated" });
    //   }
    // );

    app.post("/assigned-assets", verifyToken, verifyAdmin, async (req, res) => {
      const data = req.body;
      const hrEmail = data.hrEmail;

      const asset = await assetCollection.findOne({
        _id: new ObjectId(data.assetId),
      });

      if (!asset || asset.availableQuantity <= 0) {
        return res.status(400).send({ message: "Asset not available" });
      }

      const hrUser = await userCollection.findOne({ email: hrEmail });
      if (!hrUser || hrUser.packageLimit <= 0) {
        return res.status(403).send({ message: "Package limit exceeded" });
      }

      // ✅ 1. INSERT INTO requestCollection (AUTO APPROVED)
      const requestDoc = {
        assetId: asset._id,
        assetName: asset.productName,
        assetImage: asset.productImage,
        assetType: asset.productType,

        requesterName: data.employeeName,
        requesterEmail: data.employeeEmail,

        hrEmail,
        companyName: data.companyName,

        requestDate: new Date(),
        approvalDate: new Date(),
        requestStatus: "approved",

        productQuantity: asset.productQuantity,
        availableQuantity: asset.availableQuantity - 1,
        requesterBirthOfDate: data.employeeDateOfBirth || "",

        note: "Assigned directly by HR",
        processedBy: hrEmail,

        returnDeadline: asset.productType === "Returnable" ? new Date() : null,
      };

      const requestResult = await requestCollection.insertOne(requestDoc);

      // ✅ 2. INSERT INTO assignedAssetsCollection
      await assignedAssetsCollection.insertOne({
        assetId: asset._id,
        assetName: asset.productName,
        assetImage: asset.productImage,
        assetType: asset.productType,

        employeeEmail: data.employeeEmail,
        employeeName: data.employeeName,
        employeeDateOfBirth: data.employeeDateOfBirth,

        hrEmail,
        companyName: data.companyName,

        assignmentDate: new Date(),
        returnDate: null,
        status: "assigned",

        requestId: requestResult.insertedId, // 🔗 link
      });

      // ✅ 3. UPDATE asset quantity
      await assetCollection.updateOne(
        { _id: asset._id },
        { $inc: { availableQuantity: -1 } }
      );

      // ✅ 4. UPDATE HR limits
      await userCollection.updateOne(
        { email: hrEmail },
        { $inc: { packageLimit: -1, currentEmployees: 1 } }
      );

      res.send({
        success: true,
        message: "Asset assigned with request record",
      });
    });


    // api for summary 
    // apis for dashboardHome page

    app.get(
  "/assigned-assets",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    const hrEmail = req.decodedEmail;

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 5;
    const skip = (page - 1) * limit;

    const query = { hrEmail };

    const total = await assignedAssetsCollection.countDocuments(query);

    const assets = await assignedAssetsCollection
      .find(query)
      .sort({ assignmentDate: -1 })
      .skip(skip)
      .limit(limit)
      .toArray();

    res.send({
      data: assets,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    });
  }
);














  } finally {
    // do not close client
  }
}
run().catch(console.dir);

// default route
app.get("/", (req, res) => {
  res.send("assignment 11 is running!");
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
