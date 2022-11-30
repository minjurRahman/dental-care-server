const express = require('express');
const cors = require('cors');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const jwt = require('jsonwebtoken');
const { query } = require('express');
require('dotenv').config();

const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

const port = process.env.PORT || 5000;

const app = express();

//middleware
app.use(cors());
app.use(express.json());


const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.bjaguop.mongodb.net/?retryWrites=true&w=majority`;
const client = new MongoClient(uri, { useNewUrlParser: true, useUnifiedTopology: true, serverApi: ServerApiVersion.v1 });


//Verify JWT
function verifyJWT(req, res, next){
  const authHeader = req.headers.authorization;
  if(!authHeader){
    return res.status(401).send('Unauthorized Access');
  }

  const token = authHeader.split(' ')[1];

  jwt.verify(token, process.env.ACCESS_TOKEN, function(err, decoded){
    if(err){
      return res.status(403).send({message: 'forbidden access'})
    }
    req.decoded = decoded;
    next();
  })

}



 async function run(){
  try{

    const appointmentOptionsCollections = client.db('DentalCare').collection('appointmentsOptions');
    const bookingsCollections = client.db('DentalCare').collection('bookings');
    const usersCollections = client.db('DentalCare').collection('users');
    const doctorsCollections = client.db('DentalCare').collection('doctors');
    const paymentsCollections = client.db('DentalCare').collection('payments');
    
    //Verify Admin /Note: make sure you use verifyAdmin after verifyJWT
    const verifyAdmin = async (req, res, next) =>{
      const decodedEmail = req.decoded.email;
      const query = { email: decodedEmail };
      const user = await usersCollections.findOne(query);

      if(user?.role !== 'admin' ){
        return res.status(403).send({message: 'Forbidden Access'})
      }
      next();
    }


    //Use aggregate to query multiple collection and then merge data
    app.get('/appointmentsOptions', async(req, res) =>{
      const date = req.query.date;
      const query = {};
      const options = await appointmentOptionsCollections.find(query).toArray();
    
      // get the bookings of the provided date
      const bookingQuery = {appointmentDate: date}
      const alreadyBooked = await bookingsCollections.find(bookingQuery).toArray();
     
      //code carefully(74-5)
      options.forEach(option => {
        const optionBooked = alreadyBooked.filter(book => book.treatment === option.name);
        const bookedSlots = optionBooked.map(book => book.slot);

        const remainingSlots = option.slots.filter(slot => !bookedSlots.includes(slot));
        option.slots = remainingSlots;
        console.log(date, option.name, remainingSlots.length)
      })
      res.send(options);

    });

    //MongoDB Pipeline / Lookup Aggregation /
    app.get('/v2/appointmentOptions', async(req, res) =>{
      const date = req.query.date;
      const options = await appointmentOptionsCollections.aggregate([
        {
          $lookup:{
            from: 'bookings',
            localField: 'name',
            foreignField: 'treatment',
            pipeline: [
              {
                $match: {
                  $expr: {
                    $eq: ['$appointmentDate', date]
                  }
                }
              }
            ],
            as: 'booked'
          }
        },
        {
          $project: {
            name: 1,
            price: 1,
            slots: 1,
            booked: {
              $map: {
                input: "$booked",
                as: "book",
                in: "$$book.slot"
              }
            }
          }
        },
        {
          $project: {
            name: 1,
            price: 1,
            slots: {
              $setDifference: [
                '$slots', '$booked'
              ]
            }
          }
        }
      ]).toArray();
      res.send(options);
    })

    // get appointment specialty name
    app.get('/appointmentSpecialty', async(req, res) =>{
      const query = {};
      const result = await appointmentOptionsCollections.find(query).project({name: 1}).toArray();
      res.send(result)
    })


    //Temporary to update price field on appointment options: 
    // app.get('/addPrice', async(req, res) =>{
    //   const filter = {};
    //   const options = { upsert: true }
    //   const updatedDoc = {
    //     $set: {
    //       price: 99
    //     }
    //   }
    //   const result = await appointmentOptionsCollections.updateMany(filter, updatedDoc, options )
    //   res.send(result);
    // })



    /* api name gula evabe shajale bujte shohoj hoy
      * bookings
      * app.get('/bookings')
      * app.get('/bookings/:id')
      * app.post('/bookings')
      * app.patch('/bookings/:id')
      * app.delete('/bookings/:id')
    */


    //Booking data
    app.post('/bookings', async(req, res) => {
      const booking = req.body;

      const query = {
        email: booking.email,
        appointmentDate: booking.appointmentDate,
        treatment: booking.treatment
      }

      const alreadyBooked = await bookingsCollections.find(query).toArray();

      if(alreadyBooked.length){
        const message = `You already have a booking on ${booking.appointmentDate}`
        return res.send({acknowledged: false, message})
      }

      const result = await bookingsCollections.insertOne(booking);
      res.send(result);
    })

    //Show Dashboard Data
    app.get('/bookings', verifyJWT, async(req, res) =>{
      const email = req.query.email;

      const decodedEmail = req.decoded.email;
      if(email !== decodedEmail){
        return res.status(403).send({message: 'Forbidden Access'});
      }

      const query = { email: email };
      const bookings = await bookingsCollections.find(query).toArray();
      res.send(bookings);
    })
    
    //get specific booking data
    app.get('/bookings/:id', async (req, res) =>{
      const id = req.params.id;
      const query = { _id: ObjectId(id) };
      const booking = await bookingsCollections.findOne(query);
      res.send(booking);
    })



    //Users data to post
    app.post('/users', async (req, res) =>{
      const user = req.body;
      const result = await usersCollections.insertOne(user);
      res.send(result);
    })

    app.get('/users', async(req, res) =>{
      const query = {};
      const users = await usersCollections.find(query).toArray();
      res.send(users);
    })

    app.put('/users/admin/:id', verifyJWT, verifyAdmin, async(req, res) =>{
      const id = req.params.id;
      const filter = { _id: ObjectId(id) };
      const options = { upsert: true };
      const updateDoc = {
        $set: {
          role: 'admin'
        }
      }
      const result = await usersCollections.updateOne(filter, updateDoc, options);
      res.send(result);

    })

    app.get('/users/admin/:email', async(req, res) =>{
      const email = req.params.email;
      const query = { email: email }
      const user = await usersCollections.findOne(query);
      res.send({isAdmin: user?.role === 'admin'});
    })



    //JWT token
    app.get('/jwt', async(req, res) =>{
      const email = req.query.email;
      const query = {email: email};
      const user = await usersCollections.findOne(query);
      if(user){
        const token = jwt.sign({email}, process.env.ACCESS_TOKEN, {expiresIn: '7d'})
        return res.send({accessToken: token})
      }
      console.log(user);
      res.status(403).send({accessToken: ''});
    });

    //Doctors
    app.post('/doctors', verifyJWT, verifyAdmin, async(req, res) =>{
      const doctor = req.body;
      const result = await doctorsCollections.insertOne(doctor);
      res.send(result);
    })

    app.get('/doctors', verifyJWT, verifyAdmin, async(req, res) =>{
      const query = {};
      const doctors = await doctorsCollections.find(query).toArray();
      res.send(doctors);
    })

    app.delete('/doctors/:id', verifyJWT, verifyAdmin, async(req, res) =>{
      const id = req.params.id;
      const filter = { _id: ObjectId(id) };
      const result = await doctorsCollections.deleteOne(filter);
      res.send(result);
    })


    //Payment method/ Stripe
    app.post('/create-payment-intent', async(req, res) =>{
      const booking = req.body;
      const price = booking.price;
      const amount = price * 100;

      const paymentIntent = await stripe.paymentIntents.create({
        currency: 'usd',
        amount: amount,
        "payment_method_types": [
          "card"
        ]

      });
      res.send({
        clientSecret: paymentIntent.client_secret,
      });

    })


    //Payment Collection stored and get
    app.post('/payments', async(req, res) =>{
      const payment = req.body;
      const result = await paymentsCollections.insertOne(payment);
      const id = payment.bookingId;
      const filter = { _id: ObjectId(id) }
      const updatedDoc ={
        $set: {
          paid: true,
          transactionId: payment.transactionId
        }
      }
      const updatedResult = await bookingsCollections.updateOne(filter, updatedDoc)
      res.send(result);
    })



  }
  catch(error){
    console.log(error.name, error.message.bold, error.stack)
  }
  finally{

  }

 }

run()


app.get('/', async(req, res) => {
    res.send('Dental care server is running');
})

app.listen(port, () => console.log(`Dental care running om ${port}`))




