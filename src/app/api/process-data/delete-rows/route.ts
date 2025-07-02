import { NextResponse } from 'next/server';
import clientPromise from "@/lib/mongodb";
import { ObjectId } from "mongodb";
import fs from "fs/promises";
import path from "path";

const DB_NAME = process.env.DB_NAME || "my-next-app";


export async function POST(req: Request) {
  try {
    const { ids } = await req.json();

    if (!Array.isArray(ids) || ids.length === 0) {
      return NextResponse.json({ error: 'No valid IDs provided for deletion' }, { status: 400 });
    }

    const objectIds = ids.map((id) => new ObjectId(id));

    const client = await clientPromise;
    const db = client.db(DB_NAME);

    const jobCollection = db.collection('mockData');
    const historyCollection = db.collection('jobHistory');

    const jobsToDelete = await jobCollection.find({ _id: { $in: objectIds } }).toArray();
    const filePaths = jobsToDelete.map(job => job.pdfUrl ? path.join(process.cwd(), "public", job.pdfUrl) : null);

    const jobDeleteResult = await jobCollection.deleteMany({ _id: { $in: objectIds } });

    if (jobDeleteResult.deletedCount > 0) {
      const historyDeleteResult = await historyCollection.deleteMany({ jobId: { $in: objectIds } });

      for (const filePath of filePaths) {
        if (filePath) {
          try {
            await fs.unlink(filePath);
          } catch (error) {
            console.warn(`Failed to delete file: ${filePath}`, error);
          }
        }
      }

      return NextResponse.json({
        message: 'Jobs and related history deleted successfully',
        deletedJobs: jobDeleteResult.deletedCount,
        deletedHistory: historyDeleteResult.deletedCount,
      }, { status: 200 });
    }

    return NextResponse.json({ message: 'No jobs found for deletion' }, { status: 404 });

  } catch (error) {
    console.error('Error deleting jobs and history:', error);
    return NextResponse.json({ error: 'Failed to delete jobs and history' }, { status: 500 });
  }
}

